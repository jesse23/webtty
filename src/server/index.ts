import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config';
import { handleRequest } from './routes';
import { findGhosttyWeb } from './static';
import { closeAllSessions, createWebSocketServer, setLastSessionClosedHandler } from './websocket';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const config = loadConfig();
const HTTP_PORT = Number(process.env.PORT) || config.port;
const HTTP_HOST = config.host;

const { distPath, wasmPath } = findGhosttyWeb();
const projectRoot = path.resolve(__dirname, '..', '..');
const builtDistPath = path.join(projectRoot, 'dist');
const srcClientPath = path.join(projectRoot, 'src', 'client');
const clientDistPath = fs.existsSync(path.join(builtDistPath, 'client.html'))
  ? builtDistPath
  : srcClientPath;

function shutdown() {
  closeAllSessions();
  wss.close();
  const exit = () => process.exit(0);
  const shutdownTimeout = setTimeout(exit, 1000);
  httpServer.close(() => {
    clearTimeout(shutdownTimeout);
    exit();
  });
}

const httpServer = http.createServer((req, res) => {
  handleRequest(req, res, distPath, wasmPath, clientDistPath, shutdown);
});

const wss = createWebSocketServer(httpServer);
setLastSessionClosedHandler(shutdown);

process.on('SIGINT', () => {
  console.log('\n\nShutting down...');
  shutdown();
});

httpServer.listen(HTTP_PORT, HTTP_HOST, () => {
  console.log(`listening on http://${HTTP_HOST}:${HTTP_PORT}`);
});
