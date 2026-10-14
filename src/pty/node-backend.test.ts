import { describe, expect, test } from 'bun:test';
import nodePty from '@lydell/node-pty';
import {
  liveNodeBackendDeps,
  type NodeBackendDeps,
  type NodePtyModule,
  spawnNodePty,
} from './node-backend';
import type { PtySpawnOptions } from './pty-process';

/** Options for a spawn; `shell` varies per test. */
const options = (shell = '/bin/zsh'): PtySpawnOptions => ({
  shell,
  cols: 100,
  rows: 30,
  term: 'xterm-256color',
  colorTerm: 'truecolor',
  cwd: '/work',
  env: { A: 'config', TERM: 'overridden' },
});

/** A fake node-pty that records every call in `log` and lets a test emit data and exit. */
function fakeNodePty() {
  const log: string[] = [];
  const spawns: { file: string; args: string[]; opts: Record<string, unknown> }[] = [];
  let dataCb: ((data: string) => void) | undefined;
  let exitCb: ((e: { exitCode: number; signal?: number }) => void) | undefined;
  const module: NodePtyModule = {
    spawn(file, args, opts) {
      spawns.push({ file, args, opts: opts as Record<string, unknown> });
      return {
        pid: 777,
        onData: (cb) => {
          dataCb = cb;
        },
        onExit: (cb) => {
          exitCb = cb;
        },
        write: (data) => log.push(`write ${JSON.stringify(data)}`),
        resize: (cols, rows) => log.push(`resize ${cols}x${rows}`),
        pause: () => log.push('pause'),
        resume: () => log.push('resume'),
        kill: () => log.push('kill'),
      };
    },
  };
  return {
    module,
    log,
    spawns,
    emitData: (data: string) => dataCb?.(data),
    emitExit: (exitCode: number) => exitCb?.({ exitCode, signal: 0 }),
  };
}

/** Deps around a fake node-pty on `platform`, with a fixed base environment. */
function deps(platform: string, fake = fakeNodePty()): NodeBackendDeps & { fake: typeof fake } {
  return { nodePty: fake.module, platform, baseEnv: { HOME: '/home/u', A: 'base' }, fake };
}

describe('spawnNodePty arguments', () => {
  test.each([
    ['win32', 'C:\\Windows\\System32\\cmd.exe', ['/d']],
    ['win32', 'CMD.EXE', ['/d']],
    ['win32', 'C:\\Program Files\\PowerShell\\pwsh.exe', []],
    ['linux', '/usr/bin/cmd.exe', []],
    ['darwin', '/bin/zsh', []],
  ])('on %s, %s is started with %p', (platform, shell, args) => {
    const d = deps(platform);
    spawnNodePty(options(shell), d);
    expect(d.fake.spawns[0]?.file).toBe(shell);
    expect(d.fake.spawns[0]?.args).toEqual(args);
  });

  test('passes the size, cwd and TERM name, and layers config env then TERM/COLORTERM over the base env', () => {
    const d = deps('linux');
    spawnNodePty(options(), d);
    expect(d.fake.spawns[0]?.opts).toEqual({
      name: 'xterm-256color',
      cols: 100,
      rows: 30,
      cwd: '/work',
      env: { HOME: '/home/u', A: 'config', TERM: 'xterm-256color', COLORTERM: 'truecolor' },
    });
  });
});

describe('spawnNodePty handle', () => {
  test('maps every PtyProcess method onto the node-pty process', () => {
    const d = deps('linux');
    const pty = spawnNodePty(options(), d);
    expect(pty.pid).toBe(777);
    pty.write('ls\n');
    pty.resize(120, 40);
    pty.pause?.();
    pty.resume?.();
    pty.kill();
    expect(d.fake.log).toEqual(['write "ls\\n"', 'resize 120x40', 'pause', 'resume', 'kill']);
  });

  test('forwards output and exit to the registered callbacks', () => {
    const d = deps('linux');
    const pty = spawnNodePty(options(), d);
    const seen: string[] = [];
    pty.onData((data) => seen.push(`data ${data}`));
    pty.onExit((e) => seen.push(`exit ${e.exitCode}`));
    d.fake.emitData('hello');
    d.fake.emitExit(3);
    expect(seen).toEqual(['data hello', 'exit 3']);
  });
});

describe('liveNodeBackendDeps', () => {
  test('reads the real addon, platform and environment', () => {
    const live = liveNodeBackendDeps();
    expect(live.nodePty).toBe(nodePty);
    expect(live.platform).toBe(process.platform);
    expect(live.baseEnv).toBe(process.env);
  });
});
