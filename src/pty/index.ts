export interface PtyProcess {
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

const isBun = !!process.versions.bun;
console.log(`pty: ${isBun ? 'Bun.Terminal' : 'node-pty'}`);

const { spawn: _spawn } = await (isBun ? import('./bun.ts') : import('./node.ts'));

export const spawn = _spawn;
