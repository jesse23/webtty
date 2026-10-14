// Starting and stopping the webtty server as a detached background process. A service over
// injected deps (spawn, filesystem, config, reachability probe), with the src/dist entry
// arithmetic split out as the pure resolveServerEntry (ADR 063).
import * as childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Config, configDir, loadConfig } from '../config';
import { isWindows, runningUnderBun } from '../runtime';
import { getBaseUrl, isServerRunning } from './http';

/** Where the CLI module runs from, and with which executor the server will run. */
export interface ServerEntryOptions {
  /** The directory of the running CLI module: `src/cli` or `dist/cli`. */
  cliDir: string;
  /** True when the CLI runs from TypeScript source (`src/cli/*.ts`). */
  runningFromSrc: boolean;
  /** True when the server must run under Node.js, which cannot run `.ts` files. */
  useNode: boolean;
}

/**
 * The server entry to spawn. Under Node.js it is always the built `dist/server/index.js`; under
 * Bun it is the sibling of the CLI, `src/server/index.ts` from source or `dist/server/index.js`
 * once built.
 */
export function resolveServerEntry({
  cliDir,
  runningFromSrc,
  useNode,
}: ServerEntryOptions): string {
  if (useNode) {
    return runningFromSrc
      ? path.resolve(cliDir, '../../dist/server/index.js') // src/cli → dist/server
      : path.resolve(cliDir, '../server/index.js'); // dist/cli → dist/server
  }
  return path.resolve(cliDir, runningFromSrc ? '../server/index.ts' : '../server/index.js');
}

/** Returns the path to the server log file: `~/.config/webtty/server.log`. */
export function logPath(): string {
  return path.join(configDir(), 'server.log');
}

/** The part of a spawned ChildProcess that startServer uses. */
export interface ServerChild {
  on(event: 'error', listener: (err: Error) => void): unknown;
  unref(): void;
}

/** `child_process.spawn` narrowed to the one call startServer makes, so a fake needs no casts. */
export type SpawnServer = (
  command: string,
  args: string[],
  options: childProcess.SpawnOptions,
) => ServerChild;

/** Everything startServer touches outside itself; {@link defaultServerProcessDeps} gives the real ones. */
export interface ServerProcessDeps {
  spawn: SpawnServer;
  loadConfig: () => Config;
  existsSync: (p: string) => boolean;
  /** Opens the log file for appending (creating its directory) and returns the fd. */
  openLog: (file: string) => number;
  closeFd: (fd: number) => void;
  isRunning: () => Promise<boolean>;
  err: (text: string) => void;
  /** Ends the process; a fake may return, so startServer returns right after it. */
  exit: (code: number) => void;
  sleep: (ms: number) => Promise<void>;
  /** The environment the server inherits (PORT is set on top of it). */
  env: NodeJS.ProcessEnv;
  /** The executable running the CLI, reused for the server unless `useNode`. */
  execPath: string;
  /**
   * On Windows, Bun's net.Socket doesn't support the fd-based named-pipe wrapping that
   * node-pty's ConPTY backend requires, so node-pty fails under Bun on Windows. bunx works
   * because its #!/usr/bin/env node shim runs the server with Node.js instead; this mirrors it.
   */
  useNode: boolean;
  entry: Omit<ServerEntryOptions, 'useNode'>;
}

/** The production deps, read per call so tests that stub `process.platform` see their stub. */
export function defaultServerProcessDeps(): ServerProcessDeps {
  const moduleFile = fileURLToPath(import.meta.url);
  return {
    spawn: childProcess.spawn,
    loadConfig,
    existsSync: fs.existsSync,
    openLog: (file) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      return fs.openSync(file, 'a');
    },
    closeFd: fs.closeSync,
    isRunning: isServerRunning,
    err: (text) => console.error(text),
    exit: (code) => process.exit(code),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    env: process.env,
    execPath: process.execPath,
    useNode: isWindows() && runningUnderBun(),
    entry: { cliDir: path.dirname(moduleFile), runningFromSrc: moduleFile.endsWith('.ts') },
  };
}

/**
 * Spawns the server process detached, then polls until it is ready or `timeoutMs` expires.
 * Exits 1 when the entry is missing, the spawn fails or the server never answers.
 *
 * @param timeoutMs - Maximum time to wait for the server to start.
 * @param overrides - Deps to replace, for tests; the rest are {@link defaultServerProcessDeps}.
 */
export async function startServer(
  timeoutMs = 10000,
  overrides: Partial<ServerProcessDeps> = {},
): Promise<void> {
  const deps = { ...defaultServerProcessDeps(), ...overrides };
  const { useNode } = deps;
  const serverExec = useNode ? 'node' : deps.execPath;
  const serverEntry = resolveServerEntry({ ...deps.entry, useNode });
  if (!deps.existsSync(serverEntry)) {
    deps.err(`webtty: server entry not found at ${serverEntry}`);
    deps.exit(1);
    return;
  }

  const config = deps.loadConfig();
  let stdio: childProcess.SpawnOptions['stdio'] = 'ignore';
  let logFd: number | undefined;
  if (config.logs) {
    logFd = deps.openLog(logPath());
    stdio = ['ignore', logFd, logFd];
  }

  const child = deps.spawn(serverExec, [serverEntry], {
    detached: true,
    stdio,
    env: { ...deps.env, PORT: String(config.port) },
  });
  child.on('error', (err) => {
    const hint = useNode
      ? ' (Node.js must be on PATH when running webtty under Bun on Windows)'
      : '';
    deps.err(`webtty: failed to start server: ${err.message}${hint}`);
    deps.exit(1);
  });
  child.unref();
  if (logFd !== undefined) deps.closeFd(logFd);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await deps.isRunning()) return;
    await deps.sleep(100);
  }
  deps.err('webtty: server did not start in time');
  deps.exit(1);
}

/**
 * Sends `POST /api/server/stop`, then polls until the server is no longer reachable.
 *
 * @param baseUrl - The server base URL (default: getBaseUrl()).
 * @param timeoutMs - Maximum time to wait for the server to stop (default: 5000 ms).
 * @returns `true` if the server stopped successfully, `false` otherwise.
 */
export async function stopServer(
  baseUrl: string = getBaseUrl(),
  timeoutMs = 5000,
): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/api/server/stop`, { method: 'POST' });
    if (!res.ok) return false;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!(await isServerRunning())) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  } catch {
    return false;
  }
}
