export type { PtyProcess } from './types';

const isBun = !!process.versions.bun;
console.log(`pty: ${isBun ? 'Bun.Terminal' : 'node-pty'}`);

const { spawn: _spawn } = await (isBun ? import('./bun') : import('./node'));

export const spawn = _spawn;
