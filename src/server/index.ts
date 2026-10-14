// The server entry (dist/server/index.js): reads the environment and the config, builds the
// server with createServer, listens, and installs the process handlers. A thin entry; the
// wiring is in app.ts (ADR 062).
import { loadConfig } from '../config';
import { createServer, type WebttyServer } from './app';
import { MissingWasmError, resolveServerPaths, type ServerPaths } from './server-paths';
import { SessionStore } from './sessions/session-store';

/** Resolves the server's files, or prints which one is missing and exits 1. */
function pathsOrExit(): ServerPaths {
  try {
    return resolveServerPaths();
  } catch (err) {
    if (!(err instanceof MissingWasmError)) throw err;
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

/** Starts webtty on the configured (or `PORT`) host and port. */
function main(): void {
  const config = loadConfig();
  const port = Number(process.env.PORT) || config.port;
  // PORT is consumed for our own listen port above; clear it so it doesn't leak
  // into PTY shells and `/execute` invocations, which inherit process.env.
  delete process.env.PORT;
  // 'localhost' resolves to ::1 (IPv6) on modern macOS/Node; bind to 127.0.0.1 instead
  // but keep 'localhost' as the display host so browser URLs use it as intended.
  const displayHost = config.host;
  const host = config.host === 'localhost' ? '127.0.0.1' : config.host;

  const paths = pathsOrExit();

  // The one registry of sessions. Once the last shell exits the server stops itself.
  const store = new SessionStore({ onEmpty: () => server.shutdown() });

  process.on('uncaughtException', (err) => {
    console.error('[webtty] uncaughtException:', err);
  });
  process.on('unhandledRejection', (reason) => {
    console.error('[webtty] unhandledRejection:', reason);
  });

  const server: WebttyServer = createServer({
    loadConfig,
    store,
    paths,
    onStop: () => process.exit(0),
  });

  process.on('SIGINT', () => {
    console.log('\n\nShutting down...');
    server.shutdown();
  });

  server.httpServer.listen(port, host, () => {
    console.log(`listening on http://${displayHost}:${port}`);
  });
}

main();
