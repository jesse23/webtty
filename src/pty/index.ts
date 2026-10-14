// The PTY layer's facade: picks a backend once at load, logs the choice, and exposes
// spawnPty(options) to the server (ADR 062). The backend modules are imported lazily, so
// the node-pty addon is never loaded where Bun.Terminal is used.
import { bunTerminalAvailable, processRuntime, type RuntimeEnv } from '../runtime';
import type { PtyProcess, PtySpawnOptions } from './pty-process';

export type { PtyProcess, PtySpawnOptions, SpawnPty } from './pty-process';

/** The two PTY backends, named as the startup log line prints them. */
export type PtyBackendName = 'Bun.Terminal' | 'node-pty';

/**
 * Chooses the PTY backend for a runtime. Bun.Terminal does not implement PTY on Windows
 * (Bun.spawn({ terminal }) is a no-op there), so fall back to node-pty on that platform.
 * On all other platforms, prefer Bun.Terminal when running under Bun.
 */
export function selectBackend(env: RuntimeEnv = processRuntime()): PtyBackendName {
  return bunTerminalAvailable(env) ? 'Bun.Terminal' : 'node-pty';
}

const backendName = selectBackend();
console.log(`pty: ${backendName}`);

const backend =
  backendName === 'Bun.Terminal'
    ? (await import('./bun-backend')).spawnBunPty
    : (await import('./node-backend')).spawnNodePty;

/** Starts a shell in a PTY with the backend chosen at load; the server's SpawnPty in production. */
export function spawnPty(options: PtySpawnOptions): PtyProcess {
  return backend(options);
}
