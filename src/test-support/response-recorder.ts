// A real http.ServerResponse whose setHeader, writeHead and end only record their arguments,
// so the HTTP helper tests can pin the exact calls without a socket. Test support (ADR 064).
import { spyOn } from 'bun:test';
import http from 'node:http';
import { Socket } from 'node:net';

/** A response and the ordered list of `[method, ...args]` calls made on it. */
export function recordResponse(): { res: http.ServerResponse; calls: unknown[][] } {
  const res = new http.ServerResponse(new http.IncomingMessage(new Socket()));
  const calls: unknown[][] = [];
  spyOn(res, 'setHeader').mockImplementation((...a) => {
    calls.push(['setHeader', ...a]);
    return res;
  });
  spyOn(res, 'writeHead').mockImplementation((...a: unknown[]) => {
    calls.push(['writeHead', ...a]);
    return res;
  });
  spyOn(res, 'end').mockImplementation((...a: unknown[]) => {
    calls.push(['end', ...a]);
    return res;
  });
  return { res, calls };
}
