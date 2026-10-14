// Everything a CLI command reaches outside itself: the API client, the config, the output
// streams, the exit call, server start/stop, the browser, the editor and the TTY. Types plus a
// factory over the real globals, so every command is tested in-process with fakes (ADR 063).
import { type Config, loadConfig } from '../config';
import { getVersion } from '../version';
import { configuredClient, type WebttyClient } from './api-client';
import { openBrowser } from './browser-opener';
import { type EditorHost, processEditorHost } from './commands/edit-config';
import { type KeyTty, processKeyTty } from './commands/key';
import { startServer, stopServer } from './server-process';

/** Starting and stopping the background server process. */
export interface ServerControl {
  /** Spawns the server and waits until it answers; exits the CLI if it never does. */
  start(): Promise<void>;
  /** Asks the server to stop and waits until it is gone; false if it did not stop. */
  stop(): Promise<boolean>;
}

/** What main() and the commands need from the process; tests pass recording fakes. */
export interface CliDeps {
  /** The webtty server's API. */
  client: WebttyClient;
  /** Reads `~/.config/webtty/config.json` (on every call, as the CLI always has). */
  config(): Config;
  /** Prints one line to stdout (console.log). */
  out(text: string): void;
  /** Prints one line to stderr (console.error). */
  err(text: string): void;
  /** Writes raw text to stdout and stderr, for `run`'s streamed output. */
  write: { stdout(text: string): void; stderr(text: string): void };
  /** Ends the process with `code`; a fake may return, so callers return right after it. */
  exit(code: number): void;
  /** The package version `webtty -v` prints. */
  version(): string;
  server: ServerControl;
  /** Opens `url` in the default browser (a no-op under tests or WEBTTY_NO_OPEN=1). */
  openBrowser(url: string): void;
  /** The config file and the editor `webtty config` opens it in. */
  editor: EditorHost;
  /** The raw-mode terminal `webtty key` reads from. */
  tty: KeyTty;
}

/**
 * The production deps: the real console, process, config, server process and browser. Nothing
 * is read here, so `webtty -v` and `help` still never touch the config file.
 *
 * @param client - The API client; the configured server's by default.
 */
export function createCliDeps(client: WebttyClient = configuredClient()): CliDeps {
  return {
    client,
    config: loadConfig,
    out: (text) => console.log(text),
    err: (text) => console.error(text),
    write: {
      stdout: (text) => {
        process.stdout.write(text);
      },
      stderr: (text) => {
        process.stderr.write(text);
      },
    },
    exit: (code) => process.exit(code),
    version: getVersion,
    server: { start: () => startServer(), stop: () => stopServer(client) },
    openBrowser: (url) => openBrowser(url),
    editor: processEditorHost(),
    tty: processKeyTty(),
  };
}
