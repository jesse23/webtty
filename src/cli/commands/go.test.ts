// Tests for `webtty go` over fake CLI deps: starting the server when needed, ensuring the
// session, the URL it opens and the creation errors (ADR 063).
import { describe, expect, test } from 'bun:test';
import { fakeCliDeps, RUNNING, STOPPED } from '../test-support/fake-cli-deps';
import { json } from '../test-support/scripted-fetch';
import { go } from './go';

const URL_MAIN = 'http://localhost:7681/s/main';

describe('go', () => {
  test('opens an existing session on a running server', async () => {
    const fake = fakeCliDeps({ ...RUNNING, 'GET /api/sessions/main': () => json({ id: 'main' }) });
    await go({}, fake.deps);
    expect(fake.out).toEqual([URL_MAIN]);
    expect(fake.opened).toEqual([URL_MAIN]);
    expect(fake.server).toEqual([]);
    expect([fake.err, fake.exits]).toEqual([[], []]);
  });

  test('starts the server, creates the session in --dir and opens the id the server gave', async () => {
    const fake = fakeCliDeps({
      ...STOPPED,
      'GET /api/sessions/new': () => json({ error: 'not found' }, 404),
      'POST /api/sessions': () => json({ id: 'new' }, 201),
    });
    await go({ id: 'new', baseDir: '/work' }, fake.deps);
    expect(fake.server).toEqual(['start']);
    expect(fake.requests.at(-1)?.body).toEqual({ id: 'new', baseDir: '/work' });
    expect(fake.out).toEqual(['http://localhost:7681/s/new']);
    expect(fake.opened).toEqual(['http://localhost:7681/s/new']);
  });

  test('prints the server error and exits 1 when the session cannot be created', async () => {
    const fake = fakeCliDeps({
      ...RUNNING,
      'GET /api/sessions/bad': () => json({}, 404),
      'POST /api/sessions': () => json({ error: 'bad' }, 500),
    });
    await go({ id: 'bad' }, fake.deps);
    expect(fake.err).toEqual(['webtty: bad']);
    expect(fake.exits).toEqual([1]);
    expect([fake.out, fake.opened]).toEqual([[], []]);
  });

  test('without a server error it names the status', async () => {
    const fake = fakeCliDeps({
      ...RUNNING,
      'GET /api/sessions/bad': () => json({}, 404),
      'POST /api/sessions': () => json({}, 503),
    });
    await go({ id: 'bad' }, fake.deps);
    expect(fake.err).toEqual(['webtty: failed to create session (503)']);
    expect(fake.exits).toEqual([1]);
  });

  test('the URL brackets an IPv6 bind host', async () => {
    const fake = fakeCliDeps({ ...RUNNING, 'GET /api/sessions/main': () => json({}) });
    const config = fake.deps.config();
    fake.deps.config = () => ({ ...config, host: '::1' });
    await go({}, fake.deps);
    expect(fake.out).toEqual(['http://[::1]:7681/s/main']);
  });
});
