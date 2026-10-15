import { describe, expect, test } from 'bun:test';
import type { TerminalEffects } from '../ghostty-web/ghostty';
import { InputHandler } from '../ghostty-web/input-handler';
import { Terminal } from '../ghostty-web/terminal';
import { loadGhostty } from './support/wasm';

describe('Terminal options', () => {
  // The configured cursor shape is the engine's default, which DECSCUSR Ps 0 and RIS
  // restore; the output is not scanned (ADR 049).
  function cursorTerm() {
    const term = new Terminal({ ghostty: {} as never });
    const defaults: unknown[] = [];
    const internals = term as unknown as { isOpen: boolean; wasmTerm: object };
    internals.wasmTerm = {
      setDefaultCursor: (style: string, blink: boolean) => defaults.push([style, blink]),
    };
    return { term, defaults, internals };
  }

  test('a cursor option change after open() sets the engine default', () => {
    const { term, defaults, internals } = cursorTerm();
    internals.isOpen = true;
    term.options.cursorStyle = 'underline';
    term.options.cursorBlink = true;
    // Setting the value it already has applies nothing
    term.options.cursorBlink = true;
    expect(defaults).toEqual([
      ['underline', false],
      ['underline', true],
    ]);
  });

  test('a change before open() is kept and applied by nothing', () => {
    const { term, defaults } = cursorTerm();
    term.options.cursorStyle = 'bar';
    expect(term.options.cursorStyle).toBe('bar');
    expect(defaults).toEqual([]);
  });

  test('fills every option it is not given with its default', () => {
    const term = new Terminal({ ghostty: {} as never, fontSize: 20 });
    expect([term.options.fontSize, term.options.fontFamily, term.cols, term.rows]).toEqual([
      20,
      'monospace',
      80,
      24,
    ]);
  });

  test('a right-click defaults to contextMenu', () => {
    expect(new Terminal({ ghostty: {} as never }).options.rightClickBehavior).toBe('contextMenu');
  });
});

describe('Terminal paste', () => {
  // Pastes are encoded by ghostty_terminal_paste and leave through onData (ADR 049).
  async function pasteTerm(options: object = {}) {
    const ghostty = await loadGhostty();
    const wasmTerm = ghostty.createTerminal(40, 10);
    const term = new Terminal({ ghostty: {} as never, ...options });
    const internals = term as unknown as { isOpen: boolean; wasmTerm: unknown };
    internals.wasmTerm = wasmTerm;
    internals.isOpen = true;
    const sent: string[] = [];
    term.onData((data) => sent.push(data));
    return { term, wasmTerm, sent };
  }

  test('sends the text as Ghostty encodes it for the mode', async () => {
    const { term, wasmTerm, sent } = await pasteTerm();
    term.paste('one\ntwo\x1b');
    wasmTerm.write('\x1b[?2004h');
    term.paste('three');
    expect(sent).toEqual(['one\rtwo ', '\x1b[200~three\x1b[201~']);
    wasmTerm.free();
  });

  test('sends nothing with stdin disabled', async () => {
    const { term, wasmTerm, sent } = await pasteTerm({ disableStdin: true });
    term.paste('hello');
    expect(sent).toEqual([]);
    expect(wasmTerm.hasResponse()).toBe(false);
    wasmTerm.free();
  });
});

describe('Terminal clearScreen', () => {
  // Ghostty's clear_screen with what libghostty-vt has: the erasing is written to the
  // terminal, and only FF, at a prompt, goes to the app (ADR 054).
  async function clearTerm(options: object = {}) {
    const ghostty = await loadGhostty();
    const wasmTerm = ghostty.createTerminal(20, 5);
    const term = new Terminal({ ghostty: {} as never, ...options });
    const internals = term as unknown as { isOpen: boolean; wasmTerm: unknown };
    internals.wasmTerm = wasmTerm;
    internals.isOpen = true;
    const sent: string[] = [];
    term.onData((data) => sent.push(data));
    const text = (cells: { codepoint: number }[] | null) =>
      (cells ?? [])
        .map((c) => (c.codepoint ? String.fromCodePoint(c.codepoint) : ' '))
        .join('')
        .trimEnd();
    const screen = () => Array.from({ length: 5 }, (_, y) => text(wasmTerm.getLine(y)));
    const scrollback = () =>
      Array.from({ length: wasmTerm.getScrollbackLength() }, (_, i) =>
        text(wasmTerm.getScrollbackLine(i)),
      );
    const fill = () => {
      for (let i = 0; i < 8; i++) term.write(`line${i}\r\n`);
    };
    return { term, wasmTerm, sent, screen, scrollback, fill };
  }

  test('away from a prompt, drops the scrollback and the rows above the cursor', async () => {
    const { term, wasmTerm, sent, screen, scrollback, fill } = await clearTerm();
    fill();
    term.write('$ make');
    expect(term.clearScreen()).toBe(true);
    expect(screen()).toEqual(['$ make', '', '', '', '']);
    expect(scrollback()).toEqual([]);
    expect(wasmTerm.getCursor()).toMatchObject({ x: 6, y: 0 });
    // Output in progress carries on below the cursor's row
    term.write('\r\nok');
    expect(screen()).toEqual(['$ make', 'ok', '', '', '']);
    expect(sent).toEqual([]);
    wasmTerm.free();
  });

  test('with the cursor on the top row, drops only the scrollback', async () => {
    const { term, wasmTerm, screen, scrollback, fill } = await clearTerm();
    fill();
    term.write('\x1b[H');
    expect(term.clearScreen()).toBe(true);
    expect(screen()).toEqual(['line4', 'line5', 'line6', 'line7', '']);
    expect(scrollback()).toEqual([]);
    wasmTerm.free();
  });

  test('at an OSC 133 prompt, erases everything and sends FF for the shell to redraw', async () => {
    const { term, wasmTerm, sent, screen, scrollback, fill } = await clearTerm();
    fill();
    term.write('\x1b]133;A\x07~ > \x1b]133;B\x07ls');
    expect(wasmTerm.cursorAtPrompt()).toBe(true);
    expect(term.clearScreen()).toBe(true);
    expect(screen()).toEqual(['', '', '', '', '']);
    expect(scrollback()).toEqual([]);
    expect(sent).toEqual(['\x0c']);
    wasmTerm.free();
  });

  test('sends no FF with stdin disabled', async () => {
    const { term, wasmTerm, sent } = await clearTerm({ disableStdin: true });
    term.write('\x1b]133;A\x07$ \x1b]133;B\x07');
    expect(term.clearScreen()).toBe(true);
    expect(sent).toEqual([]);
    wasmTerm.free();
  });

  test('does nothing on the alternate screen, where the key goes to the app', async () => {
    const { term, wasmTerm, sent, screen, fill } = await clearTerm();
    fill();
    term.write('\x1b[?1049h\x1b[Hvim');
    expect(term.clearScreen()).toBe(false);
    expect(screen()[0]).toBe('vim');
    term.write('\x1b[?1049l');
    expect(wasmTerm.getScrollbackLength()).toBe(4);
    expect(sent).toEqual([]);
    wasmTerm.free();
  });

  test('clears the selection', async () => {
    const { term, wasmTerm, fill } = await clearTerm();
    fill();
    let cleared = 0;
    (term as unknown as { selectionManager: object }).selectionManager = {
      clearSelection: () => cleared++,
    };
    term.clearScreen();
    expect(cleared).toBe(1);
    wasmTerm.free();
  });

  test('waits for a sequence cut off by the end of a write, and clears where it ends', async () => {
    const { term, wasmTerm, screen, scrollback, fill } = await clearTerm();
    fill();
    term.write('build \x1b[3');
    expect(term.clearScreen()).toBe(true);
    expect(scrollback().length).toBeGreaterThan(0);
    // The rest of the SGR finishes it; the clear goes in there, before the text after it
    term.write('1mred\r\nnext');
    expect(screen()).toEqual(['build red', 'next', '', '', '']);
    expect(scrollback()).toEqual([]);
    const red = wasmTerm.getLine(0)?.[6];
    expect(red && red.fg_r > red.fg_g).toBe(true);
    wasmTerm.free();
  });

  test('a cut-off OSC keeps its effect', async () => {
    const { term, wasmTerm, scrollback, fill } = await clearTerm();
    fill();
    const titles: string[] = [];
    term.onTitleChange((t) => titles.push(t));
    term.write('\x1b]2;bui');
    term.clearScreen();
    term.write('ld\x07');
    expect(titles).toEqual(['build']);
    expect(scrollback()).toEqual([]);
    wasmTerm.free();
  });

  test('a write that ends inside another sequence still gets the clear', async () => {
    const { term, wasmTerm, screen, scrollback, fill } = await clearTerm();
    fill();
    term.write('a\x1b[3');
    term.clearScreen();
    term.write('1mb\x1b[0');
    expect(scrollback()).toEqual([]);
    term.write('mc');
    expect(screen()).toEqual(['abc', '', '', '', '']);
    wasmTerm.free();
  });

  test('a waiting clear at a prompt checks the prompt and sends FF once it goes in', async () => {
    const { term, wasmTerm, sent, screen, fill } = await clearTerm();
    fill();
    term.write('\x1b]133;A\x07$ \x1b]133;B\x07\x1b[3');
    term.clearScreen();
    expect(sent).toEqual([]);
    term.write('1m');
    expect(screen()).toEqual(['', '', '', '', '']);
    expect(sent).toEqual(['\x0c']);
    wasmTerm.free();
  });

  test('a waiting clear is dropped if the screen has turned alternate', async () => {
    const { term, wasmTerm, scrollback, fill } = await clearTerm();
    fill();
    term.write('\x1b[?1049');
    term.clearScreen();
    term.write('h\x1b[Hvim');
    term.write('\x1b[?1049l');
    expect(scrollback().length).toBeGreaterThan(0);
    wasmTerm.free();
  });
});

describe('Terminal find', () => {
  // Find with libghostty-vt's search, run in the render loop (ADR 055).
  async function findTerm() {
    const ghostty = await loadGhostty();
    const term = new Terminal({ ghostty, cols: 20, rows: 4, scrollbackLines: 1000 });
    const highlights: unknown[] = [];
    const renderer = {
      clear: () => {},
      getMetrics: () => ({ width: 8, height: 16, baseline: 12 }),
      devicePixelRatio: 1,
      setSearchHighlights: (h: unknown) => highlights.push(h),
      render: () => {},
    };
    const internals = term as unknown as {
      isOpen: boolean;
      wasmTerm: ReturnType<typeof ghostty.createTerminal>;
      ghostty: typeof ghostty;
      renderer: typeof renderer;
      showScrollbar: () => void;
      finder: { step(now: number): void };
    };
    internals.wasmTerm = ghostty.createTerminal(20, 4, { scrollbackLines: 1000 });
    internals.ghostty = ghostty;
    internals.renderer = renderer;
    internals.isOpen = true;
    internals.showScrollbar = () => {};
    let now = 0;
    /** Render-loop frames: the search steps before each. */
    const frames = (n = 1) => {
      for (let i = 0; i < n; i++) {
        now += 1000;
        internals.finder.step(now);
      }
    };
    const states: unknown[] = [];
    term.onFindChange((s) => states.push(s));
    const last = () =>
      highlights[highlights.length - 1] as {
        matches: Int32Array;
        selected: unknown;
      } | null;
    return { term, internals, frames, states, last };
  }

  test('output keeps a scrolled view on its rows while a match is selected', async () => {
    const { term, internals, frames } = await findTerm();
    term.write('needle\r\n');
    for (let i = 0; i < 20; i++) term.write(`line ${i}\r\n`);
    term.find('needle');
    frames(2);
    term.findNext();
    const view = term.viewportY;
    expect(view).toBeGreaterThan(0);
    term.write('more\r\nmore\r\nmore\r\n');
    expect(term.viewportY).toBe(view);
    frames();
    expect(term.viewportY).toBe(view + 3);
    // The view still starts at the match
    expect(term.getScrollbackLength() - term.viewportY).toBe(0);
    internals.wasmTerm.free();
  });

  test('without a selected match, output scrolls to the bottom as before', async () => {
    const { term, internals, frames } = await findTerm();
    for (let i = 0; i < 20; i++) term.write(`line ${i}\r\n`);
    term.find('line');
    frames(2);
    term.scrollToLine(5);
    term.write('x\r\n');
    expect(term.viewportY).toBe(0);
    internals.wasmTerm.free();
  });

  test('a key or a paste scrolls a view on a selected match to the bottom', async () => {
    // Ghostty's `scroll-to-bottom = keystroke` (ADR 055)
    const { term, internals, frames } = await findTerm();
    const input = term as unknown as { handleInput: (data: string, mouse?: boolean) => void };
    term.write('needle\r\n');
    for (let i = 0; i < 20; i++) term.write(`line ${i}\r\n`);
    term.find('needle');
    frames(2);
    term.findNext();
    const view = term.viewportY;
    expect(view).toBeGreaterThan(0);
    // A mouse report leaves the view alone
    input.handleInput('\x1b[M !!', true);
    expect(term.viewportY).toBe(view);
    input.handleInput('l');
    expect(term.viewportY).toBe(0);
    // and the echo is followed
    term.write('l\r\n');
    frames();
    expect(term.viewportY).toBe(0);
    term.findNext();
    expect(term.viewportY).toBeGreaterThan(0);
    term.paste('ls');
    expect(term.viewportY).toBe(0);
    internals.wasmTerm.free();
  });

  test('output that switches to the alternate screen scrolls to the bottom', async () => {
    const { term, internals, frames } = await findTerm();
    term.write('needle\r\n');
    for (let i = 0; i < 20; i++) term.write(`line ${i}\r\n`);
    term.find('needle');
    frames(2);
    term.findNext();
    expect(term.viewportY).toBeGreaterThan(0);
    term.write('\x1b[?1049hpager');
    expect(term.viewportY).toBe(0);
    frames();
    expect(term.viewportY).toBe(0);
    internals.wasmTerm.free();
  });

  test('ending the search clears the highlights and the count', async () => {
    const { term, internals, frames, states, last } = await findTerm();
    term.write('abc abc');
    term.find('abc');
    frames();
    term.findNext();
    frames();
    term.endFind();
    expect(term.finding).toBe(false);
    expect(last()).toBeNull();
    expect(states[states.length - 1]).toEqual({ total: 0, selected: null });
    frames();
    expect(last()).toBeNull();
    internals.wasmTerm.free();
  });

  test('a reset (reconnect) searches the new engine', async () => {
    const { term, internals, frames, states } = await findTerm();
    term.write('abc');
    term.find('abc');
    frames();
    expect(states[states.length - 1]).toEqual({ total: 1, selected: null });
    term.reset();
    frames();
    expect(states[states.length - 1]).toEqual({ total: 0, selected: null });
    term.write('abc abc');
    frames();
    expect(states[states.length - 1]).toEqual({ total: 2, selected: null });
    internals.wasmTerm.free();
  });
});

describe('Terminal bell and title', () => {
  // Bell and title come from the engine's readEffects, not from scanning the output
  // (ADR 047).
  test('a bell and a title reported by readEffects reach onBell and onTitleChange', () => {
    const term = new Terminal({ ghostty: {} as never });
    let effects: TerminalEffects = {
      bell: true,
      title: 'vim',
      clipboard: null,
      notifications: [],
    };
    (term as unknown as { wasmTerm: object }).wasmTerm = {
      write: () => {},
      hasResponse: () => false,
      readResponse: () => null,
      getMode: () => false,
      readEffects: () => {
        const e = effects;
        effects = { bell: false, title: null, clipboard: null, notifications: [] };
        return e;
      },
    };
    const write = (data: string) =>
      (term as unknown as { writes: { write(data: string): void } }).writes.write(data);
    let bells = 0;
    const titles: string[] = [];
    term.onBell(() => bells++);
    term.onTitleChange((title) => titles.push(title));

    write('\x1b]2;vim\x07\x07');
    expect(bells).toBe(1);
    expect(titles).toEqual(['vim']);
    // A BEL or OSC 2 the engine did not report fires nothing.
    write('\x07\x1b]2;other\x07');
    expect(bells).toBe(1);
    expect(titles).toEqual(['vim']);
  });
});

describe('Terminal focus reports', () => {
  // The focus tracker hears of each write and of a new connection (ADR 053); its own
  // tests are in core/focus-tracker.test.ts.
  test('reports when a write sets mode 1004, and on resyncFocus, the focus it has', async () => {
    const ghostty = await loadGhostty();
    const wasmTerm = ghostty.createTerminal(20, 2);
    const term = new Terminal({ ghostty: {} as never });
    const internals = term as unknown as { isOpen: boolean; wasmTerm: unknown };
    internals.wasmTerm = wasmTerm;
    internals.isOpen = true;
    const sent: string[] = [];
    term.onData((data) => sent.push(data));
    term.resyncFocus();
    expect(sent).toEqual([]);
    term.write('\x1b[?1004h');
    term.resyncFocus();
    expect(sent).toEqual(['\x1b[O', '\x1b[O']);
    wasmTerm.free();
  });
});

describe('Terminal clipboard writes', () => {
  // Program clipboard writes come from the engine's readEffects and reach the embedder
  // through onClipboardWrite (ADR 052).
  test('OSC 52 output fires onClipboardWrite with the decoded text, once', async () => {
    const ghostty = await loadGhostty();
    const term = new Terminal({ ghostty: {} as never });
    (term as unknown as { wasmTerm: unknown }).wasmTerm = ghostty.createTerminal(20, 2);
    const write = (data: string) =>
      (term as unknown as { writes: { write(data: string): void } }).writes.write(data);
    const copied: string[] = [];
    term.onClipboardWrite((text) => copied.push(text));

    write(`\x1b]52;c;${Buffer.from('héllo 中文').toString('base64')}\x07`);
    expect(copied).toEqual(['héllo 中文']);
    write('plain output');
    write('\x1b]52;c;\x07');
    expect(copied).toEqual(['héllo 中文', '']);
  });

  test('dispose drops onClipboardWrite listeners', () => {
    const term = new Terminal({ ghostty: {} as never });
    const copied: string[] = [];
    term.onClipboardWrite((text) => copied.push(text));
    term.dispose();
    (
      term as unknown as { clipboardWriteEmitter: { fire(t: string): void } }
    ).clipboardWriteEmitter.fire('x');
    expect(copied).toEqual([]);
  });
});

describe('Terminal desktop notifications', () => {
  // OSC 9 and OSC 777 come from the engine's readEffects and reach the embedder through
  // onDesktopNotification (ADR 056).
  test('OSC 9 and OSC 777 output fire onDesktopNotification, each once, in order', async () => {
    const ghostty = await loadGhostty();
    const term = new Terminal({ ghostty: {} as never });
    (term as unknown as { wasmTerm: unknown }).wasmTerm = ghostty.createTerminal(20, 2);
    const write = (data: string) =>
      (term as unknown as { writes: { write(data: string): void } }).writes.write(data);
    const shown: { title: string; body: string }[] = [];
    term.onDesktopNotification((n) => shown.push(n));

    write('\x1b]9;Build done\x07\x1b]777;notify;Claude Code;Needs your input\x1b\\');
    expect(shown).toEqual([
      { title: '', body: 'Build done' },
      { title: 'Claude Code', body: 'Needs your input' },
    ]);
    write('plain output');
    expect(shown).toHaveLength(2);
  });
});

describe('Terminal input and the selection', () => {
  // Keys and text clear the selection; mouse reports leave it, so a Shift selection in an
  // app with any-motion mode 1003 survives the next hover or click (ADR 051).
  test('a mouse report keeps the selection, a key clears it', async () => {
    const ghostty = await loadGhostty();
    const term = new Terminal({ ghostty: {} as never });
    const internals = term as unknown as { selectionManager: unknown };
    let selection = 'hello';
    internals.selectionManager = {
      clearSelection: () => {
        selection = '';
      },
    };
    const sent: string[] = [];
    term.onData((data) => sent.push(data));
    type Listener = (e: object) => void;
    const listeners = new Map<string, Listener[]>();
    const container = {
      ownerDocument: undefined,
      contains: () => true,
      addEventListener: (type: string, l: Listener) =>
        listeners.set(type, [...(listeners.get(type) ?? []), l]),
      removeEventListener: () => {},
    };
    const fire = (type: string, e: object) => {
      for (const l of listeners.get(type) ?? []) l(e);
    };
    const handler = new InputHandler({
      ghostty,
      container: container as unknown as HTMLElement,
      onData: (term as unknown as { handleInput(d: string, m?: boolean): void }).handleInput,
      mouseConfig: { hasMouseTracking: () => true, encode: () => '\x1b[<35;4;4M' },
    });
    const mods = { shiftKey: false, altKey: false, ctrlKey: false, metaKey: false };
    fire('mousemove', { ...mods, target: container, buttons: 0, clientX: 1, clientY: 1 });
    fire('mousedown', {
      ...mods,
      target: container,
      button: 0,
      buttons: 1,
      clientX: 1,
      clientY: 1,
    });
    expect(sent.length).toBe(2);
    expect(selection).toBe('hello');
    fire('keydown', {
      ...mods,
      key: 'a',
      code: 'KeyA',
      isComposing: false,
      preventDefault: () => {},
    });
    expect(sent[2]).toBe('a');
    expect(selection).toBe('');
    handler.dispose();
  });
});

describe('Terminal jumpToPrompt', () => {
  // Ghostty's jump_to_prompt on libghostty-vt's DELTA_PROMPT, in webtty's view (ADR 057).
  async function promptTerm() {
    const ghostty = await loadGhostty();
    const term = new Terminal({ ghostty, cols: 20, rows: 5 });
    const internals = term as unknown as {
      isOpen: boolean;
      wasmTerm: ReturnType<typeof ghostty.createTerminal>;
      showScrollbar: () => void;
    };
    internals.wasmTerm = ghostty.createTerminal(20, 5);
    internals.isOpen = true;
    internals.showScrollbar = () => {};
    return { term, internals };
  }
  const command = (name: string) =>
    `\x1b]133;A\x07$ \x1b]133;B\x07${name}\r\n\x1b]133;C\x07` +
    Array.from({ length: 6 }, (_, i) => `${name} ${i}`).join('\r\n') +
    '\r\n\x1b]133;D;0\x07';

  test('scrolls a prompt to the top row, up and down, and back to the bottom', async () => {
    const { term, internals } = await promptTerm();
    // Prompts on rows 0, 7 and 14; 17 rows of scrollback
    term.write(`${command('one')}${command('two')}${command('three')}\x1b]133;A\x07$ `);
    const scrolls: number[] = [];
    term.onScroll((y) => scrolls.push(y));
    term.jumpToPrompt(-1);
    expect(term.viewportY).toBe(17 - 14);
    term.jumpToPrompt(-1);
    expect(term.viewportY).toBe(17 - 7);
    term.jumpToPrompt(-1);
    term.jumpToPrompt(-1);
    expect(term.viewportY).toBe(17);
    term.jumpToPrompt(1);
    expect(term.viewportY).toBe(10);
    term.jumpToPrompt(2);
    expect(term.viewportY).toBe(0);
    expect(scrolls).toEqual([3, 10, 17, 10, 0]);
    internals.wasmTerm.free();
  });

  test('leaves a fractional view alone when there is nowhere to go', async () => {
    const { term, internals } = await promptTerm();
    term.write(Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\r\n'));
    term.viewportY = 2.5;
    term.jumpToPrompt(-1);
    term.jumpToPrompt(1);
    expect(term.viewportY).toBe(2.5);
    internals.wasmTerm.free();
  });
});
