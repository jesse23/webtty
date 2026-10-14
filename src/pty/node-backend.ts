// The node-pty PTY backend: a SpawnPty built on the `@lydell/node-pty` native addon, used
// under Node and on Windows. The addon and the platform are injected so the argument and
// event mapping is tested without a real PTY (ADR 062).
import nodePty from '@lydell/node-pty';
import type { PtyProcess, PtySpawnOptions } from './pty-process';

/** The part of the node-pty module this backend calls; a test passes a fake. */
export type NodePtyModule = Pick<typeof nodePty, 'spawn'>;

/** What {@link spawnNodePty} reads from outside its options, defaulting to the live process. */
export interface NodeBackendDeps {
  /** The node-pty module. */
  nodePty: NodePtyModule;
  /** `process.platform`; decides the cmd.exe AutoRun flag. */
  platform: string;
  /** The server's own environment, which the config's `env` is layered over. */
  baseEnv: Record<string, string | undefined>;
}

/** Reads {@link NodeBackendDeps} from the live process, per spawn as before the split. */
export function liveNodeBackendDeps(): NodeBackendDeps {
  return { nodePty, platform: process.platform, baseEnv: process.env };
}

/**
 * Spawns a PTY-backed shell using the `@lydell/node-pty` native addon.
 *
 * @returns A {@link PtyProcess} handle for reading/writing and managing the PTY.
 */
export function spawnNodePty(
  options: PtySpawnOptions,
  deps: NodeBackendDeps = liveNodeBackendDeps(),
): PtyProcess {
  const { shell, cols, rows, term, colorTerm, cwd, env } = options;
  // On Windows, cmd.exe may have an AutoRun registry key that launches shell
  // enhancers (e.g. clink). These take over the ConPTY pipe and cause
  // ERR_SOCKET_CLOSED on the first write. Pass /d to disable AutoRun.
  const shellArgs = deps.platform === 'win32' && /cmd\.exe$/i.test(shell) ? ['/d'] : [];

  const ptyProc = deps.nodePty.spawn(shell, shellArgs, {
    name: term,
    cols,
    rows,
    cwd,
    env: { ...deps.baseEnv, ...env, TERM: term, COLORTERM: colorTerm },
  });

  return {
    pid: ptyProc.pid,
    onData(cb) {
      ptyProc.onData(cb);
    },
    onExit(cb) {
      ptyProc.onExit(cb);
    },
    write(data) {
      ptyProc.write(data);
    },
    resize(cols, rows) {
      ptyProc.resize(cols, rows);
    },
    pause() {
      ptyProc.pause();
    },
    resume() {
      ptyProc.resume();
    },
    kill() {
      ptyProc.kill();
    },
  };
}
