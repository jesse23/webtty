import { describe, expect, mock, test } from 'bun:test';
import { FakeSocket } from '../../test-support/fake-socket';
import { SessionStore } from './session-store';

describe('SessionStore.create and get', () => {
  test('registers the new session under its ID', () => {
    const store = new SessionStore();
    const session = store.create('a', '/tmp');
    expect(session.id).toBe('a');
    expect(session.baseDir).toBe('/tmp');
    expect(store.get('a')).toBe(session);
    expect(store.has('a')).toBe(true);
    expect(store.size).toBe(1);
  });

  test('an unknown ID is absent', () => {
    const store = new SessionStore();
    expect(store.get('nope')).toBeUndefined();
    expect(store.has('nope')).toBe(false);
    expect(store.size).toBe(0);
  });

  test('list returns the sessions in creation order', () => {
    const store = new SessionStore();
    store.create('b');
    store.create('a');
    expect(store.list().map((s) => s.id)).toEqual(['b', 'a']);
  });

  test('two stores do not share sessions', () => {
    const one = new SessionStore();
    one.create('a');
    expect(new SessionStore().has('a')).toBe(false);
  });
});

describe('SessionStore.lastUsedId', () => {
  test('starts null and follows markUsed', () => {
    const store = new SessionStore();
    expect(store.lastUsedId).toBeNull();
    store.markUsed('a');
    expect(store.lastUsedId).toBe('a');
  });
});

describe('SessionStore.rename', () => {
  test('moves the session to the new ID and updates its id field', () => {
    const store = new SessionStore();
    const session = store.create('old');
    expect(store.rename('old', 'new')).toBe(session);
    expect(session.id).toBe('new');
    expect(store.has('old')).toBe(false);
    expect(store.get('new')).toBe(session);
  });

  test('the last-used ID follows the rename', () => {
    const store = new SessionStore();
    store.create('old');
    store.markUsed('old');
    store.rename('old', 'new');
    expect(store.lastUsedId).toBe('new');
  });

  test('another last-used ID is left alone', () => {
    const store = new SessionStore();
    store.create('old');
    store.create('other');
    store.markUsed('other');
    store.rename('old', 'new');
    expect(store.lastUsedId).toBe('other');
  });

  test('an unknown ID returns undefined and changes nothing', () => {
    const store = new SessionStore();
    store.markUsed('ghost');
    expect(store.rename('ghost', 'new')).toBeUndefined();
    expect(store.has('new')).toBe(false);
    expect(store.lastUsedId).toBe('ghost');
  });
});

describe('SessionStore.remove', () => {
  test('unregisters the session and returns it', () => {
    const store = new SessionStore();
    const session = store.create('a');
    store.create('b');
    expect(store.remove('a')).toBe(session);
    expect(store.has('a')).toBe(false);
    expect(store.size).toBe(1);
  });

  test('forgets the session as the last-used one', () => {
    const store = new SessionStore();
    store.create('a');
    store.markUsed('a');
    store.remove('a');
    expect(store.lastUsedId).toBeNull();
  });

  test('keeps another last-used ID', () => {
    const store = new SessionStore();
    store.create('a');
    store.create('b');
    store.markUsed('b');
    store.remove('a');
    expect(store.lastUsedId).toBe('b');
  });

  test('an unknown ID returns undefined', () => {
    expect(new SessionStore().remove('nope')).toBeUndefined();
  });

  test('a session whose shell exited is unregistered but stays the last-used ID', () => {
    const store = new SessionStore();
    store.create('a');
    store.markUsed('a');
    store.removeExited('a');
    expect(store.has('a')).toBe(false);
    expect(store.lastUsedId).toBe('a');
  });
});

describe('SessionStore.notifyIfEmpty', () => {
  test('calls onEmpty once when the last session has gone', () => {
    const onEmpty = mock(() => {});
    const store = new SessionStore({ onEmpty });
    store.create('a');
    store.create('b');
    store.removeExited('a');
    store.notifyIfEmpty();
    expect(onEmpty).not.toHaveBeenCalled();
    store.removeExited('b');
    store.notifyIfEmpty();
    expect(onEmpty).toHaveBeenCalledTimes(1);
  });

  test('without onEmpty an empty store does nothing', () => {
    expect(() => new SessionStore().notifyIfEmpty()).not.toThrow();
  });
});

describe('SessionStore.findByPid', () => {
  test('finds the session whose PTY has the process ID', () => {
    const store = new SessionStore();
    store.create('idle');
    const running = store.create('running');
    running.pty = { pid: 4242 } as never;
    expect(store.findByPid(4242)).toBe(running);
  });

  test('returns undefined when no PTY has the process ID', () => {
    const store = new SessionStore();
    store.create('idle');
    expect(store.findByPid(4242)).toBeUndefined();
  });
});

describe('SessionStore.closeAll', () => {
  test('closes every session with the code and keeps them registered', () => {
    const store = new SessionStore();
    const a = new FakeSocket([], 'a');
    const b = new FakeSocket([], 'b');
    store.create('a').clients.add(a);
    store.create('b').subscribers.add(b);
    store.closeAll(1001, 'server stopped');
    expect(a.closed).toEqual({ code: 1001, reason: 'server stopped' });
    expect(b.closed).toEqual({ code: 1001, reason: 'server stopped' });
    expect(store.size).toBe(2);
  });
});
