// Tests for the event subscriber handler: the close codes for an unknown session and a
// session with no shell, and subscribing until the socket closes (ADR 062).
import { describe, expect, test } from 'bun:test';
import { FakePty } from '../../test-support/fake-pty';
import { FakeSocket } from '../../test-support/fake-socket';
import { SessionStore } from '../sessions/session-store';
import { WS_CLOSE } from './close-codes';
import { handleEventsSocket } from './events-socket';

describe('handleEventsSocket', () => {
  test('an unknown session closes the subscriber with SESSION_GONE', () => {
    const ws = new FakeSocket();
    handleEventsSocket(new SessionStore(), ws, 'nope');
    expect(ws.closed).toEqual({ code: WS_CLOSE.SESSION_GONE, reason: 'session deleted' });
  });

  test('a session with no shell closes the subscriber with PTY_NOT_RUNNING', () => {
    const store = new SessionStore();
    store.create('s');
    const ws = new FakeSocket();
    handleEventsSocket(store, ws, 's');
    expect(ws.closed).toEqual({ code: WS_CLOSE.PTY_NOT_RUNNING, reason: 'PTY not running' });
    expect(store.get('s')?.subscribers.size).toBe(0);
  });

  test('a running session subscribes the socket until it closes; errors are ignored', () => {
    const store = new SessionStore();
    const session = store.create('s');
    session.pty = new FakePty();
    const ws = new FakeSocket();
    handleEventsSocket(store, ws, 's');
    expect(session.subscribers.has(ws)).toBe(true);
    session.broadcastEvent('{"e":1}');
    expect(ws.sent).toEqual(['{"e":1}']);
    ws.emit('error', new Error('reset'));
    expect(session.subscribers.has(ws)).toBe(true);
    ws.emit('close');
    expect(session.subscribers.size).toBe(0);
  });
});
