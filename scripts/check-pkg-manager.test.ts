import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import {
  checkPackageManager,
  foreignPackageManager,
  foreignPackageManagerMessage,
} from './check-pkg-manager';

describe('foreignPackageManager', () => {
  test.each([
    ['', undefined],
    ['bun/1.3.11 npm/? node/v24.3.0 darwin arm64', undefined],
    ['npm/10.9.2 node/v22.12.0 darwin arm64 workspaces/false', 'npm'],
    ['pnpm/9.15.0 npm/? node/v22.12.0 darwin arm64', 'pnpm'],
    ['yarn/1.22.22 npm/? node/v22.12.0 darwin arm64', 'yarn'],
    ['/odd', 'unknown'],
  ])('%j is %p', (agent, expected) => {
    expect(foreignPackageManager(agent)).toBe(expected);
  });
});

describe('foreignPackageManagerMessage', () => {
  test('names the manager it saw and asks for bun install, in red', () => {
    expect(foreignPackageManagerMessage('npm')).toBe(
      '\n\x1b[31m  ERROR: This project uses Bun. Run `bun install` instead.\x1b[0m\n\n' +
        '  Detected: npm\n  Run:      bun install\n',
    );
  });
});

describe('checkPackageManager', () => {
  test('passes Bun silently and fails npm with the message', () => {
    const errors: string[] = [];
    expect(checkPackageManager('bun/1.3.11', (m) => errors.push(m))).toBe(0);
    expect(checkPackageManager('npm/10.9.2', (m) => errors.push(m))).toBe(1);
    expect(errors).toEqual([foreignPackageManagerMessage('npm')]);
  });
});

describe('check-pkg-manager.ts as a process', () => {
  const run = (agent: string | undefined) => {
    const env = { ...process.env };
    if (agent === undefined) delete env.npm_config_user_agent;
    else env.npm_config_user_agent = agent;
    return Bun.spawnSync([process.execPath, path.join(import.meta.dir, 'check-pkg-manager.ts')], {
      env,
    });
  };

  test('passes under bun or with no user agent', () => {
    expect(run('bun/1.3.11').exitCode).toBe(0);
    expect(run(undefined).exitCode).toBe(0);
  });

  test('fails under npm with the message on stderr', () => {
    const proc = run('npm/10.9.2 node/v22.12.0');
    expect(proc.exitCode).toBe(1);
    expect(proc.stderr.toString()).toBe(`${foreignPackageManagerMessage('npm')}\n`);
  });
});
