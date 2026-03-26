import type http from 'node:http';
import path from 'node:path';
import { loadConfig } from '../config';
import {
  createSession,
  generateId,
  isValidId,
  lastUsedId,
  sessionRegistry,
  sessionToJson,
  setLastUsedId,
} from './session';
import { serveFile } from './static';
import { closeSession } from './websocket';

const MAX_BODY = 64 * 1024;

function decodeId(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

export function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY) {
        req.destroy();
        reject(Object.assign(new Error('payload too large'), { status: 413 }));
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

export async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  distPath: string,
  wasmPath: string,
  clientDistPath: string,
  onStop: () => void,
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
  const pathname = url.pathname;

  if (req.method === 'POST' && pathname === '/api/server/stop') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('stopping');
    onStop();
    return;
  }

  if (req.method === 'GET' && pathname === '/api/config') {
    const config = loadConfig();
    // Whitelist client-safe keys — avoid exposing server-side config (shell, host, logs, etc.)
    const clientConfig = {
      cols: config.cols,
      rows: config.rows,
      fontSize: config.fontSize,
      fontFamily: config.fontFamily,
      cursorStyle: config.cursorStyle,
      cursorStyleBlink: config.cursorStyleBlink,
      scrollback: config.scrollback,
      theme: config.theme,
      copyOnSelect: config.copyOnSelect,
      rightClickBehavior: config.rightClickBehavior,
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(clientConfig));
    return;
  }

  if (pathname === '/api/sessions') {
    if (req.method === 'GET') {
      const list = [...sessionRegistry.values()].map(sessionToJson);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(list));
      return;
    }

    if (req.method === 'POST') {
      let body: { id?: string };
      try {
        body = (await readJson(req)) as { id?: string };
      } catch (err) {
        const status = (err as { status?: number }).status === 413 ? 413 : 400;
        res.writeHead(status);
        res.end(status === 413 ? 'Payload Too Large' : 'invalid JSON');
        return;
      }

      const id = body.id ?? generateId();
      if (!isValidId(id)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `invalid id: ${id}` }));
        return;
      }
      if (sessionRegistry.has(id)) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `session already exists: ${id}` }));
        return;
      }
      const session = createSession(id);
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(sessionToJson(session)));
      return;
    }
  }

  const sessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (sessionMatch) {
    const id = decodeId(sessionMatch[1]);
    if (!id) {
      res.writeHead(400);
      res.end('Bad Request');
      return;
    }

    if (req.method === 'GET') {
      const session = sessionRegistry.get(id);
      if (!session) {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(sessionToJson(session)));
      return;
    }

    if (req.method === 'PATCH') {
      let body: { id?: string };
      try {
        body = (await readJson(req)) as { id?: string };
      } catch (err) {
        const status = (err as { status?: number }).status === 413 ? 413 : 400;
        res.writeHead(status);
        res.end(status === 413 ? 'Payload Too Large' : 'invalid JSON');
        return;
      }

      const session = sessionRegistry.get(id);
      if (!session) {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }

      const newId = body.id;
      if (!newId) {
        res.writeHead(400);
        res.end('missing id');
        return;
      }
      if (!isValidId(newId)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `invalid id: ${newId}` }));
        return;
      }
      if (sessionRegistry.has(newId)) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `session already exists: ${newId}` }));
        return;
      }
      sessionRegistry.delete(id);
      session.id = newId;
      sessionRegistry.set(newId, session);
      if (lastUsedId === id) setLastUsedId(newId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(sessionToJson(session)));
      return;
    }

    if (req.method === 'DELETE') {
      const session = sessionRegistry.get(id);
      if (!session) {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }
      sessionRegistry.delete(id);
      if (lastUsedId === id) setLastUsedId(null);
      closeSession(session);
      res.writeHead(204, { 'X-Sessions-Remaining': String(sessionRegistry.size) });
      res.end();
      return;
    }
  }

  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    let targetId = lastUsedId ?? null;
    if (!targetId || !sessionRegistry.has(targetId)) {
      if (!sessionRegistry.has('main')) createSession('main');
      targetId = 'main';
    }
    res.writeHead(302, { Location: `/s/${targetId}` });
    res.end();
    return;
  }

  const clientMatch = pathname.match(/^\/s\/([^/]+)$/);
  if (req.method === 'GET' && clientMatch) {
    const id = decodeId(clientMatch[1]);
    if (!id || !isValidId(id) || !sessionRegistry.has(id)) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    const clientHtml = path.resolve(clientDistPath, 'client.html');
    serveFile(clientHtml, res);
    return;
  }

  if (pathname.startsWith('/dist/')) {
    const relativePath = pathname.slice(6);
    const ownFile = path.resolve(clientDistPath, relativePath);
    if (ownFile.startsWith(clientDistPath + path.sep)) {
      const fs = await import('node:fs');
      if (fs.existsSync(ownFile)) {
        serveFile(ownFile, res);
        return;
      }
    }
    const filePath = path.resolve(distPath, relativePath);
    if (
      !filePath.startsWith(path.resolve(distPath) + path.sep) &&
      filePath !== path.resolve(distPath)
    ) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    serveFile(filePath, res);
    return;
  }

  if (pathname === '/ghostty-vt.wasm') {
    serveFile(wasmPath, res);
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
}
