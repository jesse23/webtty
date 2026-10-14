import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDomWindow, type DomWindow } from '../test-support/dom-window';
import { Ghostty, Terminal } from '../vendor/ghostty-web';
import { browserEnv, frameWindow } from './browser-env';

const WASM = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../vendor/ghostty-vt/ghostty-vt-small.wasm',
);

let dom: DomWindow;
beforeEach(() => {
  dom = createDomWindow();
});
afterEach(() => dom.close());

describe('browserEnv', () => {
  test("returns the window's own globals", () => {
    const { window } = dom;
    const env = browserEnv(window);
    expect(env.window).toBe(window);
    expect(env.document).toBe(window.document);
    expect(env.navigator).toBe(window.navigator);
    expect(env.WebSocket).toBe(window.WebSocket);
    expect(env.ResizeObserver).toBe(window.ResizeObserver);
    expect(env.performance).toBe(window.performance);
    expect(env.window.location.pathname).toBe('/s/test');
  });

  test('Notification is the constructor where there is one, else undefined', () => {
    const { window } = dom;
    class FakeNotification {}
    Object.defineProperty(window, 'Notification', { value: undefined, configurable: true });
    expect(browserEnv(window).Notification).toBeUndefined();
    Object.defineProperty(window, 'Notification', { value: FakeNotification, configurable: true });
    expect(browserEnv(window).Notification).toBe(FakeNotification as never);
  });

  test('fetch and the timers are called on the window', async () => {
    const { window } = dom;
    const calls: string[] = [];
    function record(name: string, result: unknown) {
      return function (this: unknown, ...args: unknown[]) {
        calls.push(
          `${name} ${this === window} ${args.filter((a) => a !== undefined && typeof a !== 'function')}`,
        );
        return result;
      };
    }
    const response = { ok: true };
    Object.assign(window, {
      fetch: record('fetch', Promise.resolve(response)),
      setTimeout: record('setTimeout', 7),
      clearTimeout: record('clearTimeout', undefined),
      requestAnimationFrame: record('requestAnimationFrame', 9),
      cancelAnimationFrame: record('cancelAnimationFrame', undefined),
    });
    const env = browserEnv(window);
    expect(await env.fetch('/api/config')).toBe(response as never);
    expect(env.setTimeout(() => {}, 500)).toBe(7);
    env.clearTimeout(7);
    expect(env.requestAnimationFrame(() => {})).toBe(9);
    env.cancelAnimationFrame(9);
    expect(calls).toEqual([
      'fetch true /api/config',
      'setTimeout true 500',
      'clearTimeout true 7',
      'requestAnimationFrame true ',
      'cancelAnimationFrame true 9',
    ]);
  });

  test('loadEngine loads libghostty-vt and createTerminal builds the vendored Terminal', async () => {
    const env = browserEnv(dom.window);
    const ghostty = await env.loadEngine(WASM);
    expect(ghostty).toBeInstanceOf(Ghostty);
    const term = env.createTerminal({ ghostty, cols: 40, rows: 10 });
    expect(term).toBeInstanceOf(Terminal);
    expect([term.cols, term.rows]).toEqual([40, 10]);
    term.dispose();
  });

  test("frameWindow reads the window's pixel ratio live and frames through env", () => {
    const { window } = dom;
    const env = browserEnv(window);
    const frames: string[] = [];
    env.requestAnimationFrame = () => {
      frames.push('request');
      return 3;
    };
    env.cancelAnimationFrame = (id) => {
      frames.push(`cancel ${id}`);
    };
    const view = frameWindow(env);
    Object.defineProperty(window, 'devicePixelRatio', { value: 2, configurable: true });
    expect(view.devicePixelRatio).toBe(2);
    Object.defineProperty(window, 'devicePixelRatio', { value: 1.5, configurable: true });
    expect(view.devicePixelRatio).toBe(1.5);
    expect(view.requestAnimationFrame(() => {})).toBe(3);
    view.cancelAnimationFrame(3);
    expect(frames).toEqual(['request', 'cancel 3']);
  });
});
