import { spawn } from 'node:child_process';
import fs from 'node:fs';
import type http from 'node:http';
import { homedir } from 'node:os';
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
import { broadcastToSubscribers, closeSession } from './websocket';

const MAX_BODY = 64 * 1024;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function setCors(res: http.ServerResponse): void {
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.setHeader(k, v);
}

function decodeId(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

/**
 * Reads and JSON-parses the request body (max 64 KB).
 *
 * @param req - The incoming HTTP request.
 * @returns A promise resolving to the parsed JSON object, or an empty object if body is empty.
 * @throws {Error} with `status: 413` if body exceeds 64 KB.
 * @throws {Error} if the body contains invalid JSON.
 */
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

/**
 * Main HTTP request handler for the webtty server.
 * Dispatches all REST API routes and serves static client assets.
 *
 * @param req - The incoming HTTP request.
 * @param res - The HTTP response object.
 * @param distPath - Path to the server-side dist directory.
 * @param wasmPath - Path to the ghostty-vt.wasm file.
 * @param clientDistPath - Path to the client dist directory.
 * @param onStop - Callback invoked when `POST /api/server/stop` is received.
 */
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

  setCors(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

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
      mouseScrollSpeed: config.mouseScrollSpeed,
      keyboardBindings: config.keyboardBindings,
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
      let body: { id?: string; baseDir?: string };
      try {
        body = (await readJson(req)) as { id?: string; baseDir?: string };
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
      const baseDir = body.baseDir ?? homedir();
      if (!path.isAbsolute(baseDir)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'baseDir must be an absolute path' }));
        return;
      }
      if (!fs.existsSync(baseDir)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `baseDir does not exist: ${baseDir}` }));
        return;
      }
      if (!fs.statSync(baseDir).isDirectory()) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `baseDir is not a directory: ${baseDir}` }));
        return;
      }
      const session = createSession(id, baseDir);
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

  const publishMatch = pathname.match(/^\/s\/([^/]+)\/publish$/);
  if (req.method === 'POST' && publishMatch) {
    const id = decodeId(publishMatch[1]);
    if (!id) {
      res.writeHead(400);
      res.end('Bad Request');
      return;
    }
    if (!(req.headers['content-type'] ?? '').startsWith('application/json')) {
      res.writeHead(400);
      res.end('Bad Request');
      return;
    }
    const session = sessionRegistry.get(id);
    if (!session) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    if (session.pty === null) {
      res.writeHead(409);
      res.end('PTY not running');
      return;
    }
    let buf = '';
    req.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      if (buf.length > MAX_BODY) buf = '';
      for (const line of lines) {
        const trimmed = line.replace(/\r$/, '');
        if (!trimmed) continue;
        try {
          JSON.parse(trimmed);
          broadcastToSubscribers(session, trimmed);
        } catch {
          // skip invalid JSON lines
        }
      }
    });
    req.on('end', () => {
      const trimmed = buf.replace(/\r$/, '');
      if (trimmed) {
        try {
          JSON.parse(trimmed);
          broadcastToSubscribers(session, trimmed);
        } catch {
          // skip invalid JSON
        }
      }
      res.writeHead(204);
      res.end();
    });
    req.on('error', () => {
      res.writeHead(500);
      res.end();
    });
    return;
  }

  const executeMatch = pathname.match(/^\/s\/([^/]+)\/execute$/);
  if (req.method === 'POST' && executeMatch) {
    const id = decodeId(executeMatch[1]);
    if (!id) {
      res.writeHead(400);
      res.end('Bad Request');
      return;
    }
    if (!(req.headers['content-type'] ?? '').startsWith('application/json')) {
      res.writeHead(400);
      res.end('Bad Request');
      return;
    }
    const session = sessionRegistry.get(id);
    if (!session) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    if (session.pty === null) {
      res.writeHead(409);
      res.end('PTY not running');
      return;
    }
    let execBody: unknown;
    try {
      execBody = await readJson(req);
    } catch (err) {
      const status = (err as { status?: number }).status === 413 ? 413 : 400;
      res.writeHead(status);
      res.end(status === 413 ? 'Payload Too Large' : 'invalid JSON');
      return;
    }
    const { cmd, args, stdin } = execBody as { cmd?: unknown; args?: unknown; stdin?: unknown };
    if (typeof cmd !== 'string' || cmd.length === 0) {
      res.writeHead(400);
      res.end('invalid body');
      return;
    }
    if (!Array.isArray(args) || !args.every((a) => typeof a === 'string')) {
      res.writeHead(400);
      res.end('invalid body');
      return;
    }
    let child: ReturnType<typeof spawn>;
    try {
      const execConfig = loadConfig();
      child = spawn(cmd, args as string[], {
        env: { ...process.env, ...execConfig.env },
        cwd: session.baseDir,
      });
    } catch (err) {
      res.writeHead(500);
      res.end(`spawn error: ${String(err)}`);
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson',
      'Cache-Control': 'no-cache',
    });
    let done = false;
    child.on('error', (err) => {
      if (done) return;
      done = true;
      const msg = err.message;
      const code = (err as NodeJS.ErrnoException).code;
      res.write(`${JSON.stringify({ stream: 'stderr', data: `${msg}\n` })}\n`);
      res.write(`${JSON.stringify({ exit: 1, error: msg, ...(code ? { code } : {}) })}\n`);
      res.end();
    });
    if (typeof stdin === 'string') {
      child.stdin?.write(stdin);
    }
    child.stdin?.end();
    child.stdout?.on('data', (chunk: Buffer) => {
      res.write(`${JSON.stringify({ stream: 'stdout', data: chunk.toString() })}\n`);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      res.write(`${JSON.stringify({ stream: 'stderr', data: chunk.toString() })}\n`);
    });
    child.on('close', (code: number | null) => {
      if (done) return;
      done = true;
      res.write(`${JSON.stringify({ exit: code ?? 1 })}\n`);
      res.end();
    });
    req.on('close', () => {
      if (!done) child.kill();
    });
    return;
  }

  const pidMatch = pathname.match(/^\/p\/(\d+)$/);
  if (req.method === 'GET' && pidMatch) {
    const pid = parseInt(pidMatch[1], 10);
    if (!Number.isFinite(pid) || pid <= 0) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    const session = [...sessionRegistry.values()].find((s) => s.pty?.pid === pid);
    if (!session) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    res.writeHead(302, { Location: `/s/${session.id}` });
    res.end();
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
