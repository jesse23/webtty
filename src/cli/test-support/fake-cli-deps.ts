// Test helper: CliDeps whose client talks to a scripted fetch and whose streams, exit, server
// control and browser record into arrays, so a command's output and exit code are asserted
// exactly (ADR 063, ADR 064).
import { DEFAULT_CONFIG } from '../../config';
import { WebttyClient } from '../api-client';
import type { CliDeps } from '../cli-deps';
import type { EditorHost } from '../commands/edit-config';
import type { KeyTty } from '../commands/key';
import {
  FAKE_BASE_URL,
  fakeSockets,
  type Responder,
  refused,
  type SocketBehaviour,
  scriptedFetch,
} from './scripted-fetch';

/** What a fake run should do beyond the routes. */
export interface FakeCliOptions {
  /** What the fake PTY sockets do; `open` by default. */
  socket?: SocketBehaviour;
  /** What `server.stop()` resolves to; true by default. */
  stopResult?: boolean;
  editor?: EditorHost;
  tty?: KeyTty;
}

/** Fails the test if a command touches a host it was not given. */
function unexpected(name: string): never {
  throw new Error(`unexpected use of ${name}`);
}

/** Recording CliDeps over the route table; the config is the default with host 0.0.0.0. */
export function fakeCliDeps(routes: Record<string, Responder> = {}, options: FakeCliOptions = {}) {
  const { fetchFn, requests } = scriptedFetch(routes);
  const sockets = fakeSockets(options.socket);
  const out: string[] = [];
  const err: string[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exits: number[] = [];
  const server: string[] = [];
  const opened: string[] = [];
  const deps: CliDeps = {
    client: new WebttyClient(FAKE_BASE_URL, fetchFn, sockets.openSocket),
    config: () => ({ ...DEFAULT_CONFIG, host: '0.0.0.0', port: 7681 }),
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    write: { stdout: (text) => stdout.push(text), stderr: (text) => stderr.push(text) },
    exit: (code) => exits.push(code),
    version: () => '9.9.9',
    server: {
      start: async () => {
        server.push('start');
      },
      stop: async () => {
        server.push('stop');
        return options.stopResult ?? true;
      },
    },
    openBrowser: (url) => opened.push(url),
    editor: options.editor ?? {
      configDir: () => unexpected('editor'),
      mkdirp: () => unexpected('editor'),
      exists: () => unexpected('editor'),
      writeFile: () => unexpected('editor'),
      env: {},
      platform: 'linux',
      runAttached: () => unexpected('editor'),
    },
    tty: options.tty ?? {
      isTTY: false,
      setRawMode: () => unexpected('tty'),
      resume: () => unexpected('tty'),
      onData: () => unexpected('tty'),
      once: () => unexpected('tty'),
      off: () => unexpected('tty'),
    },
  };
  return { deps, requests, sockets, out, err, stdout, stderr, exits, server, opened };
}

/** Routes for a running server with no sessions: the reachability probe answers `[]`. */
export const RUNNING: Record<string, Responder> = {
  'GET /api/sessions': () => new Response('[]'),
};

/** Routes for a server that is not running: the probe is refused. */
export const STOPPED: Record<string, Responder> = { 'GET /api/sessions': refused };
