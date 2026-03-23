import http from 'node:http';
import { loadConfig } from '../config';
import { handleRequest } from './routes';
import { sessionRegistry } from './session';
import { findGhosttyWeb } from './static';
import { createWebSocketServer } from './websocket';

const config = loadConfig();
const HTTP_PORT = Number(process.env.PORT) || config.port;
const HTTP_HOST = config.host;

const { distPath, wasmPath } = findGhosttyWeb();

const httpServer = http.createServer((req, res) => {
  handleRequest(req, res, distPath, wasmPath, config, () => {
    for (const session of sessionRegistry.values()) {
      session.pty?.kill();
      for (const client of session.clients) client.close(1001, 'server stopped');
    }
    wss.close();
    const exit = () => process.exit(0);
    const shutdownTimeout = setTimeout(exit, 1000);
    httpServer.close(() => {
      clearTimeout(shutdownTimeout);
      exit();
    });
  });
});

const wss = createWebSocketServer(httpServer);

process.on('SIGINT', () => {
  console.log('\n\nShutting down...');
  for (const session of sessionRegistry.values()) {
    session.pty?.kill();
    for (const client of session.clients) client.close(1001, 'server stopped');
  }
  wss.close();
  const exit = () => process.exit(0);
  const shutdownTimeout = setTimeout(exit, 1000);
  httpServer.close(() => {
    clearTimeout(shutdownTimeout);
    exit();
  });
});

httpServer.listen(HTTP_PORT, HTTP_HOST, () => {
  console.log(`listening on http://${HTTP_HOST}:${HTTP_PORT}`);
});
