// The whole webtty server in the test process: createServer on an OS-chosen loopback port,
// with the store's onEmpty wired to shutdown as src/server/index.ts wires it, so route,
// websocket and session code count in coverage. A test-support object (ADR 062, ADR 064).
import type { AddressInfo } from 'node:net';
import { type Config, loadConfig as loadUserConfig } from '../config';
import { createServer, type WebttyServer } from '../server/app';
import type { ServerPaths } from '../server/server-paths';
import type { SpawnPty } from '../server/sessions/session';
import { SessionStore } from '../server/sessions/session-store';

/** What a test can swap; everything else is the production wiring. */
export interface LiveServerOptions {
  /** Where the client page and the wasm are. */
  paths: ServerPaths;
  /** The config loader; {@link testShellConfig} when omitted. */
  loadConfig?: () => Config;
  /** The PTY spawner; the real one from src/pty when omitted. */
  spawnPty?: SpawnPty;
}

/** A listening server and the handles a test needs to drive and inspect it. */
export interface LiveServer {
  server: WebttyServer;
  store: SessionStore;
  /** `http://127.0.0.1:<port>`. */
  base: string;
  /** `ws://127.0.0.1:<port>`. */
  wsBase: string;
  /** How many times the server called its `onStop` hook. */
  stops: () => number;
  /** Resolves once `onStop` has been called. */
  stopped: Promise<void>;
  /** Shuts the server down (killing any shell) unless it is already stopping. */
  close: () => void;
}

/**
 * The config under the test's HOME with a predictable shell: `/bin/sh` off Windows (the
 * user's `$SHELL` may print anything at startup), and clink kept out of cmd.exe on Windows,
 * where it breaks PTY socket writes.
 */
export function testShellConfig(): Config {
  const config = loadUserConfig();
  return process.platform === 'win32'
    ? { ...config, env: { ...config.env, CLINK_NOAUTORUN: '1' } }
    : { ...config, shell: '/bin/sh' };
}

/** Builds the server with {@link createServer} and listens on port 0 of 127.0.0.1. */
export async function startLiveServer(options: LiveServerOptions): Promise<LiveServer> {
  let stops = 0;
  let markStopped!: () => void;
  const stopped = new Promise<void>((resolve) => {
    markStopped = resolve;
  });

  // Shutdown stops the listener at once; a shell it killed exits later and empties the store
  // again, and the process-exiting entry never sees that, so stop only while still listening.
  const shutdownIfListening = () => {
    if (server.httpServer.listening) server.shutdown();
  };
  const store = new SessionStore({ onEmpty: shutdownIfListening });
  const server = createServer({
    loadConfig: options.loadConfig ?? testShellConfig,
    store,
    paths: options.paths,
    spawnPty: options.spawnPty,
    onStop: () => {
      stops++;
      markStopped();
    },
  });
  await new Promise<void>((resolve) => server.httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = server.httpServer.address() as AddressInfo;

  return {
    server,
    store,
    base: `http://127.0.0.1:${port}`,
    wsBase: `ws://127.0.0.1:${port}`,
    stops: () => stops,
    stopped,
    close: () => {
      shutdownIfListening();
      // Drops keep-alive connections. It does not wait for onStop: Bun's node:http holds
      // close() open on a server that has upgraded a WebSocket, so onStop then comes only
      // after SHUTDOWN_GRACE_MS, and the listener is closed already.
      server.httpServer.closeAllConnections();
    },
  };
}
