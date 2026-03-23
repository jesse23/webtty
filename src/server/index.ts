import http from 'node:http';
import { handleRequest } from './routes';
import { sessionRegistry } from './session';
import { findGhosttyWeb } from './static';
import { createWebSocketServer } from './websocket';

const HTTP_PORT = Number(process.env.PORT) || 2346;

const { distPath, wasmPath } = findGhosttyWeb();

const httpServer = http.createServer((req, res) => {
  handleRequest(req, res, distPath, wasmPath, () => {
    for (const session of sessionRegistry.values()) {
      session.pty?.kill();
      for (const client of session.clients) client.close();
    }
    wss.close();
    httpServer.close(() => process.exit(0));
  });
});

const wss = createWebSocketServer(httpServer);

process.on('SIGINT', () => {
  console.log('\n\nShutting down...');
  for (const session of sessionRegistry.values()) {
    session.pty?.kill();
    for (const client of session.clients) client.close();
  }
  wss.close();
  process.exit(0);
});

httpServer.listen(HTTP_PORT, '127.0.0.1', () => {
  console.log(`listening on http://127.0.0.1:${HTTP_PORT}`);
});
