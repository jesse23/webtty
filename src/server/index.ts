import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config';
import { findGhosttyWasm } from './http/static-files';
import { createRequestHandler } from './routes/route-table';
import { SessionStore } from './sessions/session-store';
import { WS_CLOSE } from './ws/close-codes';
import { createWebSocketServer } from './ws/ws-upgrade';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const config = loadConfig();
const HTTP_PORT = Number(process.env.PORT) || config.port;
// PORT is consumed for our own listen port above; clear it so it doesn't leak
// into PTY shells and `/execute` invocations, which inherit process.env.
delete process.env.PORT;
// 'localhost' resolves to ::1 (IPv6) on modern macOS/Node; bind to 127.0.0.1 instead
// but keep 'localhost' as the display host so browser URLs use it as intended.
const HTTP_HOST_DISPLAY = config.host;
const HTTP_HOST = config.host === 'localhost' ? '127.0.0.1' : config.host;

const projectRoot = path.resolve(__dirname, '..', '..');
const wasmPath = findGhosttyWasm(projectRoot);
const builtDistPath = path.join(projectRoot, 'dist');
const srcClientPath = path.join(projectRoot, 'src', 'client');
const clientDistPath = fs.existsSync(path.join(builtDistPath, 'client.html'))
  ? builtDistPath
  : srcClientPath;

// The one registry of sessions. Once the last shell exits the server stops itself.
const store = new SessionStore({ onEmpty: shutdown });

function shutdown() {
  store.closeAll(WS_CLOSE.SERVER_STOPPED, 'server stopped');
  wss.close();
  const exit = () => process.exit(0);
  const shutdownTimeout = setTimeout(exit, 1000);
  httpServer.close(() => {
    clearTimeout(shutdownTimeout);
    exit();
  });
}

process.on('uncaughtException', (err) => {
  console.error('[webtty] uncaughtException:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[webtty] unhandledRejection:', reason);
});

const handleRequest = createRequestHandler({
  store,
  loadConfig,
  wasmPath,
  clientDistPath,
  onStop: shutdown,
});

const httpServer = http.createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    console.error('[webtty] unhandled route error:', err);
    if (!res.headersSent) {
      res.writeHead(500);
      res.end('Internal Server Error');
    }
  });
});

const wss = createWebSocketServer(httpServer, store);

process.on('SIGINT', () => {
  console.log('\n\nShutting down...');
  shutdown();
});

httpServer.listen(HTTP_PORT, HTTP_HOST, () => {
  console.log(`listening on http://${HTTP_HOST_DISPLAY}:${HTTP_PORT}`);
});
