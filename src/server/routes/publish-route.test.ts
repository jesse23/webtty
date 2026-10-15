// Unit tests for the publish route's stream handling that the golden tests cannot reach over
// a socket: a request stream error answers 500 (ADR 062).
import { describe, expect, spyOn, test } from 'bun:test';
import http from 'node:http';
import { Socket } from 'node:net';
import { FakePty } from '../../test-support/fake-pty';
import { recordResponse } from '../../test-support/response-recorder';
import { SessionStore } from '../sessions/session-store';
import { publishRoutes } from './publish-route';

/** A JSON POST to the session `live`, whose shell is a fake. */
function setup() {
  const store = new SessionStore();
  const session = store.create('live', '/');
  session.pty = new FakePty();
  const broadcast = spyOn(session, 'broadcastEvent').mockImplementation(() => {});
  const req = new http.IncomingMessage(new Socket());
  req.headers = { 'content-type': 'application/json' };
  const { res, calls } = recordResponse();
  const [route] = publishRoutes({ store });
  route.handle({ req, res, pathname: '/s/live/publish', params: ['live'] });
  return { req, calls, broadcast };
}

describe('publish route', () => {
  test('broadcasts each JSON line, including an unterminated last one, then 204', () => {
    const { req, calls, broadcast } = setup();
    req.emit('data', Buffer.from('{"a":1}\nnot json\n{"b"'));
    req.emit('data', Buffer.from(':2}'));
    req.emit('end');
    expect(broadcast.mock.calls).toEqual([['{"a":1}'], ['{"b":2}']]);
    expect(calls).toEqual([['writeHead', 204], ['end']]);
  });

  test('a request stream error answers 500', () => {
    const { req, calls } = setup();
    req.emit('error', new Error('reset'));
    expect(calls).toEqual([['writeHead', 500], ['end']]);
  });
});
