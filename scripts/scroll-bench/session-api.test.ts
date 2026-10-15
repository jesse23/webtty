import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { resolveServerPaths } from '../../src/server/server-paths';
import { isValidId } from '../../src/server/sessions/session-id';
import { type LiveServer, startLiveServer } from '../../src/test-support/live-server';
import { type TmpHome, useTmpHome } from '../../src/test-support/server-harness';
import { benchSessionId, createSession, deleteSession } from './session-api';

describe('benchSessionId', () => {
  test('a slug of the parts and the time, valid as a session ID', () => {
    const id = benchSessionId(['after', 'claude-classic', 'wheel', 2], 36 ** 3);
    expect(id).toBe('bench-after-claude-classic-wheel-2-1000');
    expect(isValidId(id)).toBe(true);
  });

  test('folds labels that are not ID characters and stays short', () => {
    const id = benchSessionId(['localhost:3001', 'X'.repeat(80)], 0);
    expect(id.startsWith('bench-localhost-3001-x')).toBe(true);
    expect(isValidId(id)).toBe(true);
  });
});

// Against the whole server in-process (ADR 064). The tests share one server and run in
// order; deleting its last session stops it, so that comes last.
describe('createSession and deleteSession', () => {
  let live: LiveServer;
  let home: TmpHome;
  const id = benchSessionId(['test', 'session-api'], 0);

  beforeAll(async () => {
    home = useTmpHome('scroll-bench-session-api');
    live = await startLiveServer({ paths: resolveServerPaths() });
  });

  afterAll(() => {
    live.close();
    home.restore();
  });

  test('creates the session and gives the page that opens it', async () => {
    const session = await createSession(live.base, id);
    expect(session).toEqual({ base: live.base, id, url: `${live.base}/s/${id}` });
    expect((await fetch(`${live.base}/api/sessions/${id}`)).status).toBe(200);
  });

  test('a session that cannot be created throws with the API call', async () => {
    await expect(createSession(live.base, id)).rejects.toThrow(`POST ${live.base}/api/sessions`);
  });

  test('deleting a missing session is fine', async () => {
    const missing = { base: live.base, id: 'bench-missing', url: `${live.base}/s/bench-missing` };
    await deleteSession(missing);
  });

  test('deletes the session', async () => {
    await deleteSession({ base: live.base, id, url: `${live.base}/s/${id}` });
    expect(live.store.get(id)).toBeUndefined();
  });
});
