// The client's composition root (composition root, ADR 060): builds the terminal and every
// feature on the globals in ClientEnv, in the SPEC's 13 steps (docs/specs/architecture.md,
// "The client composition root"), and returns the one disposer for all of it. The order is
// pinned by start-client.test.ts: listeners on one target and subscribers of one emitter
// run in the order they were added.

import type { PtyConnection } from '../connection/pty-connection';
import { ReplayWindow } from '../connection/replay-window';
import { installClipboard } from '../features/clipboard/clipboard-feature';
import { Composer } from '../features/compose/composer';
import { installFind } from '../features/find/find-feature';
import { installFontZoom } from '../features/keyboard/font-zoom-feature';
import { installKeyDispatcher } from '../features/keyboard/key-dispatcher';
import { screenClearer } from '../features/keyboard/screen-clear';
import { shortcutFor } from '../features/keyboard/shortcut-map';
import { installKitty } from '../features/kitty/kitty-feature';
import { browserNotifications } from '../features/notifications/browser-notifications';
import { installNotifications } from '../features/notifications/notifications-feature';
import { installPaste } from '../features/paste/paste-feature';
import { PasteService } from '../features/paste/paste-service';
import { installScroll } from '../features/scroll/scroll-feature';
import { SmoothScroll } from '../features/scroll/smooth-scroll';
import { WheelStream } from '../features/scroll/wheel-stream';
import { TabTitle } from '../features/tab-title/tab-title';
import { installTabTitle } from '../features/tab-title/tab-title-feature';
import { EdgeExtender } from '../layout/edge-extender';
import { applyPaddingColor, installLayout, type LayoutFeature } from '../layout/layout-feature';
import { installRepaintOnVisible } from '../layout/repaint-on-visible';
import { type Disposable, DisposableStore } from '../vendor/ghostty-web';
import { type ClientEnv, frameWindow } from './browser-env';
import { loadClientConfig } from './client-config';
import type { ClientContext } from './client-context';
import { connectPty } from './connect-pty';
import { detectMac } from './platform';
import { toTerminalOptions } from './terminal-options';
import { toTerminalTheme } from './terminal-theme';

/** What step 1 leaves for the rest: the context, the session and the objects built before the wasm. */
interface Bootstrap {
  ctx: ClientContext;
  sessionId: string;
  /** Whether the output being parsed is the replay sent on connect (ADR 053). */
  replay: ReplayWindow;
  tabTitle: TabTitle;
}

/** What steps 9-13 use from the steps before them. */
interface InputDeps {
  pty: PtyConnection;
  graphics: { clear(): void };
  smoothScroll: SmoothScroll;
  layout: LayoutFeature;
}

/** What step 2 builds that later steps use. */
interface Surface {
  smoothScroll: SmoothScroll;
  wheelStream: WheelStream;
  layout: LayoutFeature;
}

/**
 * Starts the client in the page `env` stands for: the terminal in `#terminal`, connected
 * to the session named by the URL. Resolves once everything is installed and the socket
 * is connecting; disposing the result removes everything it added.
 */
export async function startClient(env: ClientEnv): Promise<Disposable> {
  const store = new DisposableStore();
  // 1. Bootstrap
  const { ctx, sessionId, replay, tabTitle } = await bootstrap(env, store);
  const { term } = ctx;
  // 2. Layout and views
  const { smoothScroll, wheelStream, layout } = installSurface(ctx, env, store);
  // 3. Kitty graphics. Its replies go out through the connection made at step 7, read
  // only when a reply is sent.
  let connection: PtyConnection | undefined;
  const graphics = store.add(
    installKitty(ctx, { send: (data) => connection?.send(data), window: frameWindow(env) }),
  );
  // 4. A program's OSC 52 clipboard writes, written once the user has used this tab (ADR 052)
  const clipboard = store.add(installClipboard(ctx, { clipboard: env.navigator.clipboard }));
  // 5. The title and the bell mark (ADR 053)
  store.add(installTabTitle(ctx, { tabTitle }));
  // 6. Desktop notifications (OSC 9, OSC 777) while the terminal is not focused (ADR 056)
  store.add(
    installNotifications(ctx, {
      sessionId,
      replay,
      title: tabTitle,
      notifications: browserNotifications(env.Notification),
      userActivation: env.navigator.userActivation,
      now: () => env.performance.now(),
    }),
  );
  // 7. The PTY socket (ADR 048)
  const pty = store.add(
    connectPty(sessionId, term, env, {
      replay,
      graphics,
      smoothScroll,
      connected: () => clipboard.connected(),
    }),
  );
  connection = pty;
  // 8. Wheel scrolling: the custom wheel handler, the app's wheel pace, the glide's frame
  store.add(installScroll(ctx, { smoothScroll, wheelStream }));
  // 9-13. Find, the key dispatcher, font zoom, input to the PTY and paste
  installInput(ctx, env, store, { pty, graphics, smoothScroll, layout });
  return store;
}

/** Step 1: the session, the config, the tab title, the engine and the opened terminal. */
async function bootstrap(env: ClientEnv, store: DisposableStore): Promise<Bootstrap> {
  const doc = env.document;
  const sessionId = env.window.location.pathname.split('/s/')[1] ?? 'main';
  const config = await loadClientConfig(env.fetch);
  const replay = new ReplayWindow();
  // `<title> | webtty` from the program's OSC 0/2 title, or the session id, set before the
  // wasm loads so the tab is named at once (ADR 053)
  const tabTitle = new TabTitle(sessionId, config.bellTitle, replay, (title) => {
    doc.title = title;
  });
  // The vendored ghostty-web is bundled into /dist/client-browser.js, so its default wasm
  // lookup (relative to its own module URL) would depend on where the bundle sits. Load
  // the wasm from the path the server serves it at instead (ADR 041). It is Ghostty's
  // official libghostty-vt wasm, the only engine (ADR 042, ADR 047).
  const ghostty = await env.loadEngine('/ghostty-vt-small.wasm');
  // webtty's theme keys in ghostty-web's names, without `padding`, which is a webtty
  // setting and not a terminal colour (ADR 036)
  const terminalTheme = toTerminalTheme(config.theme ?? {});
  const term = store.add(env.createTerminal(toTerminalOptions(config, terminalTheme, ghostty)));
  const container = doc.getElementById('terminal') as HTMLElement;
  applyPaddingColor(container, config);
  await term.open(container);
  const mac = detectMac(env.navigator);
  const ctx: ClientContext = { term, container, config, terminalTheme, mac, doc, win: env.window };
  return { ctx, sessionId, replay, tabTitle };
}

/** Step 2: the edge strips, the composer, smooth scroll, the fit and its signals, the repaint. */
function installSurface(ctx: ClientContext, env: ClientEnv, store: DisposableStore): Surface {
  const { term, container, config, terminalTheme, doc } = ctx;
  const frames = frameWindow(env);
  // The strips copy the edges of the part of the canvas in view (ADR 043)
  const edges = store.add(
    new EdgeExtender(container, config.padding, () => term.renderer?.visibleArea, {
      document: doc,
      window: frames,
    }),
  );
  // IME and dictation composition shows at the cursor in the theme's colours (ADR 038)
  store.add(new Composer(term, container, terminalTheme, { document: doc, window: frames }));
  // Pixel-smooth scrollback scrolling for trackpads (ADR 040, ADR 043)
  const wheelStream = new WheelStream(env.window);
  const smoothScroll = store.add(
    new SmoothScroll(term, wheelStream, { window: env.window, performance: env.performance }),
  );
  // The fit, its first run, and the resize, font and pixel ratio signals that refit (ADR 033)
  const layout = store.add(installLayout(ctx, { ...env, edges, smoothScroll }));
  // The first of the document's visibilitychange listeners (ADR 031)
  store.add(installRepaintOnVisible(ctx));
  return { smoothScroll, wheelStream, layout };
}

/** Steps 9-13: find, the paste service, the key dispatcher, font zoom, the PTY input and paste. */
function installInput(
  ctx: ClientContext,
  env: ClientEnv,
  store: DisposableStore,
  { pty, graphics, smoothScroll, layout }: InputDeps,
): void {
  const { term, mac } = ctx;
  const clearScreen = screenClearer(term, graphics, smoothScroll);
  // 9. Find in the scrollback (ADR 055), before the dispatcher that drives it
  const find = store.add(
    installFind(ctx, { ...env, shortcutActionOf: (e) => shortcutFor(e, mac)?.action }),
  );
  // Pastes: text through the terminal, a non-text paste as Ctrl+V (ADR 014, ADR 037,
  // ADR 049). Built here as the dispatcher's paste keys use it; its listeners come at 13.
  const paste = new PasteService(term, pty, env.navigator);
  // 10. The one container capture keydown listener: configured bindings (ADR 018), then
  // Ghostty's shortcuts for this platform (ADR 054, ADR 055, ADR 057)
  store.add(
    installKeyDispatcher(ctx, {
      connection: pty,
      find,
      clearScreen,
      pasteFromClipboard: () => paste.pasteFromClipboard(),
    }),
  );
  // 11. Font zoom: the last window capture keydown listener, fitting at once (ADR 033)
  store.add(installFontZoom(ctx, { fit: () => layout.fit() }));
  // 12. Keystrokes and input to the PTY, and the grid size whenever it changes
  store.add(term.onData((data: string) => pty.send(data)));
  store.add(term.onResize(({ cols, rows }) => pty.sendResize(cols, rows)));
  // 13. The right click set to paste, then the container capture paste listener (ADR 051)
  store.add(installPaste(ctx, { paste }));
}
