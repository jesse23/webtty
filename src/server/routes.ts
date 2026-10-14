// The webtty HTTP request handler: the REST API, the page routes and static assets, as one
// ordered if-chain (ADR 062). Response and body helpers live in http/; routes/ splits this next.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import type http from 'node:http';
import { homedir } from 'node:os';
import path from 'node:path';
import { loadConfig, toClientConfig } from '../config';
import { LineSplitter } from '../ndjson';
import { getVersion } from '../version';
import { decodeId, hasJsonContentType, MAX_BODY, readJsonOrReply } from './http/request-body';
import {
  redirect,
  sendBadRequest,
  sendJson,
  sendNotFound,
  sendText,
  setCors,
} from './http/respond';
import { GHOSTTY_WASM, serveFile } from './http/static-files';
import { sessionToJson } from './sessions/session';
import { generateId, isValidId } from './sessions/session-id';
import type { SessionStore } from './sessions/session-store';
import { WS_CLOSE } from './ws/close-codes';

// readJson moved to http/request-body.ts; re-exported because the route golden test imports it here.
export { readJson } from './http/request-body';

/**
 * Main HTTP request handler for the webtty server.
 * Dispatches all REST API routes and serves static client assets.
 *
 * @param req - The incoming HTTP request.
 * @param res - The HTTP response object.
 * @param store - The server's sessions.
 * @param wasmPath - Path to the wasm served at `/ghostty-vt-small.wasm`.
 * @param clientDistPath - Path to the client dist directory.
 * @param onStop - Callback invoked when `POST /api/server/stop` is received.
 */
export async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  store: SessionStore,
  wasmPath: string,
  clientDistPath: string,
  onStop: () => void,
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
  const pathname = url.pathname;

  setCors(res);

  if (req.method === 'OPTIONS') {
    sendText(res, 204);
    return;
  }

  if (req.method === 'POST' && pathname === '/api/server/stop') {
    sendText(res, 200, 'stopping', { 'Content-Type': 'text/plain' });
    onStop();
    return;
  }

  if (req.method === 'GET' && pathname === '/api/server/status') {
    sendJson(res, 200, { version: getVersion() });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/config') {
    // Only the client-safe keys: server-side config (shell, host, logs, env…) stays here.
    const clientConfig = toClientConfig(loadConfig());
    sendJson(res, 200, clientConfig);
    return;
  }

  if (pathname === '/api/sessions') {
    if (req.method === 'GET') {
      const list = store.list().map(sessionToJson);
      sendJson(res, 200, list);
      return;
    }

    if (req.method === 'POST') {
      const read = await readJsonOrReply(req, res);
      if (!read) return;
      const body = read.value as { id?: string; baseDir?: string };

      const id = body.id ?? generateId();
      if (!isValidId(id)) {
        sendJson(res, 400, { error: `invalid id: ${id}` });
        return;
      }
      if (store.has(id)) {
        sendJson(res, 409, { error: `session already exists: ${id}` });
        return;
      }
      const baseDir = body.baseDir ?? homedir();
      if (!path.isAbsolute(baseDir)) {
        sendJson(res, 400, { error: 'baseDir must be an absolute path' });
        return;
      }
      if (!fs.existsSync(baseDir)) {
        sendJson(res, 400, { error: `baseDir does not exist: ${baseDir}` });
        return;
      }
      if (!fs.statSync(baseDir).isDirectory()) {
        sendJson(res, 400, { error: `baseDir is not a directory: ${baseDir}` });
        return;
      }
      const session = store.create(id, baseDir);
      sendJson(res, 201, sessionToJson(session));
      return;
    }
  }

  const sessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (sessionMatch) {
    const id = decodeId(sessionMatch[1]);
    if (!id) {
      sendBadRequest(res);
      return;
    }

    if (req.method === 'GET') {
      const session = store.get(id);
      if (!session) {
        sendNotFound(res);
        return;
      }
      sendJson(res, 200, sessionToJson(session));
      return;
    }

    if (req.method === 'PATCH') {
      const read = await readJsonOrReply(req, res);
      if (!read) return;
      const body = read.value as { id?: string };

      const session = store.get(id);
      if (!session) {
        sendNotFound(res);
        return;
      }

      const newId = body.id;
      if (!newId) {
        sendText(res, 400, 'missing id');
        return;
      }
      if (!isValidId(newId)) {
        sendJson(res, 400, { error: `invalid id: ${newId}` });
        return;
      }
      if (store.has(newId)) {
        sendJson(res, 409, { error: `session already exists: ${newId}` });
        return;
      }
      store.rename(id, newId);
      sendJson(res, 200, sessionToJson(session));
      return;
    }

    if (req.method === 'DELETE') {
      const session = store.remove(id);
      if (!session) {
        sendNotFound(res);
        return;
      }
      session.close(WS_CLOSE.SESSION_GONE, 'session deleted');
      sendText(res, 204, undefined, { 'X-Sessions-Remaining': String(store.size) });
      return;
    }
  }

  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    let targetId = store.lastUsedId;
    if (!targetId || !store.has(targetId)) {
      if (!store.has('main')) store.create('main');
      targetId = 'main';
    }
    redirect(res, `/s/${targetId}`);
    return;
  }

  const clientMatch = pathname.match(/^\/s\/([^/]+)$/);
  if (req.method === 'GET' && clientMatch) {
    const id = decodeId(clientMatch[1]);
    if (!id || !isValidId(id) || !store.has(id)) {
      sendNotFound(res);
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
      sendBadRequest(res);
      return;
    }
    if (!hasJsonContentType(req)) {
      sendBadRequest(res);
      return;
    }
    const session = store.get(id);
    if (!session) {
      sendNotFound(res);
      return;
    }
    if (session.pty === null) {
      sendText(res, 409, 'PTY not running');
      return;
    }
    // One event per NDJSON line; invalid JSON lines are skipped, and a line that grows past
    // 64 KB without a newline is dropped.
    const broadcastIfJson = (line: string) => {
      try {
        JSON.parse(line);
        session.broadcastEvent(line);
      } catch {
        // skip invalid JSON lines
      }
    };
    const lines = new LineSplitter({ maxLength: MAX_BODY });
    req.on('data', (chunk: Buffer) => {
      for (const line of lines.push(chunk.toString('utf8'))) broadcastIfJson(line);
    });
    req.on('end', () => {
      const last = lines.flush();
      if (last) broadcastIfJson(last);
      sendText(res, 204);
    });
    req.on('error', () => {
      sendText(res, 500);
    });
    return;
  }

  const executeMatch = pathname.match(/^\/s\/([^/]+)\/execute$/);
  if (req.method === 'POST' && executeMatch) {
    const id = decodeId(executeMatch[1]);
    if (!id) {
      sendBadRequest(res);
      return;
    }
    if (!hasJsonContentType(req)) {
      sendBadRequest(res);
      return;
    }
    const session = store.get(id);
    if (!session) {
      sendNotFound(res);
      return;
    }
    if (session.pty === null) {
      sendText(res, 409, 'PTY not running');
      return;
    }
    const read = await readJsonOrReply(req, res);
    if (!read) return;
    const { cmd, args, stdin } = read.value as { cmd?: unknown; args?: unknown; stdin?: unknown };
    if (typeof cmd !== 'string' || cmd.length === 0) {
      sendText(res, 400, 'invalid body');
      return;
    }
    if (!Array.isArray(args) || !args.every((a) => typeof a === 'string')) {
      sendText(res, 400, 'invalid body');
      return;
    }
    let child: ReturnType<typeof spawn>;
    try {
      const execConfig = loadConfig();
      child = spawn(cmd, args as string[], {
        env: { ...process.env, ...execConfig.env },
        cwd: session.baseDir,
        windowsHide: true,
      });
    } catch (err) {
      sendText(res, 500, `spawn error: ${String(err)}`);
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
      sendNotFound(res);
      return;
    }
    const session = store.findByPid(pid);
    if (!session) {
      sendNotFound(res);
      return;
    }
    redirect(res, `/s/${session.id}`);
    return;
  }

  if (pathname.startsWith('/dist/')) {
    const ownFile = path.resolve(clientDistPath, pathname.slice(6));
    if (ownFile.startsWith(clientDistPath + path.sep)) {
      serveFile(ownFile, res);
      return;
    }
    sendNotFound(res);
    return;
  }

  if (pathname === `/${GHOSTTY_WASM}`) {
    serveFile(wasmPath, res);
    return;
  }

  sendNotFound(res);
}
