// Opening a session URL in the user's browser, and turning the configured bind host into one a
// browser can navigate to. A util over an injected spawn, platform and environment (ADR 063).
import * as childProcess from 'node:child_process';

/**
 * Converts a bind host to a browser-navigable host.
 * - Bind-all addresses (`0.0.0.0`, `::`) become `localhost`.
 * - Bare IPv6 addresses are bracketed (`::1` → `[::1]`).
 * - All other values pass through unchanged.
 */
export function toBrowserHost(host: string): string {
  if (host === '0.0.0.0' || host === '::') return 'localhost';
  if (host.includes(':') && !host.startsWith('[')) return `[${host}]`;
  return host;
}

/** `child_process.spawn` narrowed to the detached, unref'd call openBrowser makes. */
export type SpawnDetached = (
  command: string,
  args: string[],
  options: childProcess.SpawnOptions,
) => { unref(): void };

/** What openBrowser reads and calls; the live process by default. */
export interface BrowserOpenerHost {
  spawn: SpawnDetached;
  platform: string;
  env: NodeJS.ProcessEnv;
}

/** The live process, read per call so a test's `process.platform` stub is seen. */
export function processBrowserHost(): BrowserOpenerHost {
  return { spawn: childProcess.spawn, platform: process.platform, env: process.env };
}

/**
 * Opens `url` in the default system browser.
 * No-op in test environments or when `WEBTTY_NO_OPEN=1` is set.
 */
export function openBrowser(url: string, host: BrowserOpenerHost = processBrowserHost()): void {
  if (host.env.WEBTTY_NO_OPEN === '1') return;
  if (host.env.NODE_ENV === 'test') return;
  if (host.platform === 'win32') {
    host.spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
  } else {
    const cmd = host.platform === 'darwin' ? 'open' : 'xdg-open';
    host.spawn(cmd, [url], { detached: true, stdio: 'ignore' }).unref();
  }
}
