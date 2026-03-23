/**
 * Type shim for @lydell/node-pty — safe to delete when both conditions are fixed upstream:
 *
 * 1. CJS/ESM mismatch: index.js does `module.exports = requirePlatformSpecificPackage()` (a CJS
 *    default export of the whole object), but node-pty.d.ts declares named exports
 *    (`export function spawn`, `export interface IPty`, etc.). With `moduleResolution: bundler`
 *    TypeScript resolves this as a default-only module, so named imports fail and `import nodePty
 *    from '@lydell/node-pty'` is the only working form. To verify: check that index.js no longer
 *    uses `module.exports = ...` and instead uses `export function spawn(...)`.
 *
 * 2. onData/onExit typed as IEvent<T> (a callable returning IDisposable) in the upstream .d.ts,
 *    which is incompatible with our PtyProcess interface that types them as plain methods. This
 *    shim re-declares them as `(cb) => void` to match. To verify: check that IPty.onData and
 *    IPty.onExit are typed as plain functions, not as IEvent<T>.
 */
declare module '@lydell/node-pty' {
  interface IPty {
    onData(cb: (data: string) => void): void;
    onExit(cb: (e: { exitCode: number; signal?: number }) => void): void;
    write(data: string): void;
    resize(cols: number, rows: number): void;
    kill(signal?: string): void;
  }

  interface ISpawnOptions {
    name?: string;
    cols?: number;
    rows?: number;
    cwd?: string;
    env?: Record<string, string | undefined>;
  }

  function spawn(file: string, args: string[], options: ISpawnOptions): IPty;

  export default { spawn };
}
