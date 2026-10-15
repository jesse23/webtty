// Runtime detection shared by the server, CLI and PTY layers: pure predicates over a
// RuntimeEnv snapshot, each defaulting to the live process (ADR 062). One predicate per
// question the code actually asks, because "is this Bun?" had three different meanings.

/** The facts about the running process that the predicates below read. */
export interface RuntimeEnv {
  /** `process.platform`, e.g. `darwin`, `linux`, `win32`. */
  platform: string;
  /** `process.execPath`, the path of the executable running this process. */
  execPath: string;
  /** `process.versions.bun`, set only when Bun is the runtime. */
  bunVersion: string | undefined;
  /** `globalThis.Bun`, defined only when Bun is the runtime. */
  bunGlobal: unknown;
}

/** Reads a fresh RuntimeEnv from the live process (read per call so tests can stub `process.platform`). */
export function processRuntime(): RuntimeEnv {
  return {
    platform: process.platform,
    execPath: process.execPath,
    bunVersion: process.versions.bun,
    bunGlobal: (globalThis as Record<string, unknown>).Bun,
  };
}

/** True on Windows, where several spawn and PTY paths differ. */
export function isWindows(env: RuntimeEnv = processRuntime()): boolean {
  return env.platform === 'win32';
}

/**
 * True when the PTY layer can use `Bun.Terminal`: running under Bun, and not on Windows,
 * where `Bun.spawn({ terminal })` is a no-op so node-pty is used instead.
 */
export function bunTerminalAvailable(env: RuntimeEnv = processRuntime()): boolean {
  return !!env.bunVersion && env.platform !== 'win32';
}

/**
 * True when the executable path names Bun. It tells how the user launched webtty
 * (`bunx` versus `npx`), which is what the session banner's help hint echoes back.
 */
export function launchedFromBunExecutable(env: RuntimeEnv = processRuntime()): boolean {
  return env.execPath.includes('bun');
}

/** True when the `Bun` global exists, i.e. this code is executing inside the Bun runtime. */
export function runningUnderBun(env: RuntimeEnv = processRuntime()): boolean {
  return typeof env.bunGlobal !== 'undefined';
}

/** The package runner to suggest in user-facing hints: `bunx` when launched from Bun, else `npx`. */
export function packageRunner(env: RuntimeEnv = processRuntime()): 'bunx' | 'npx' {
  return launchedFromBunExecutable(env) ? 'bunx' : 'npx';
}
