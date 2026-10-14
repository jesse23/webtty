import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import { GO_ALIASES, parseArgs } from './cli-args';

describe('parseArgs', () => {
  const cases: Array<[string, string[], string | undefined, string[], string | undefined]> = [
    ['no arguments', [], undefined, [], undefined],
    ['a command and its arguments', ['mv', 'a', 'b'], 'mv', ['a', 'b'], undefined],
    ['--dir before the command', ['--dir', '/tmp/x', 'go', 'id'], 'go', ['id'], '/tmp/x'],
    ['--dir after the command', ['go', '--dir', '/tmp/x', 'id'], 'go', ['id'], '/tmp/x'],
    ['--dir alone', ['--dir', '/tmp/x'], undefined, [], '/tmp/x'],
    ['--dir at the end of argv', ['go', 'id', '--dir'], 'go', ['id'], path.resolve('.')],
    ['a relative --dir', ['--dir', 'sub'], undefined, [], path.resolve('sub')],
    ['only the first --dir', ['--dir', '/a', 'go', '--dir', '/b'], 'go', ['--dir', '/b'], '/a'],
  ];
  for (const [name, args, command, rest, baseDir] of cases) {
    test(name, () => {
      expect(parseArgs(args)).toEqual({
        command,
        rest,
        baseDir: baseDir === undefined ? undefined : path.resolve(baseDir),
      });
    });
  }

  test('does not modify its input', () => {
    const args = ['--dir', '/tmp/x', 'go'];
    parseArgs(args);
    expect(args).toEqual(['--dir', '/tmp/x', 'go']);
  });
});

describe('GO_ALIASES', () => {
  test('lists exactly go, a, attach and open', () => {
    expect([...GO_ALIASES].sort()).toEqual(['a', 'attach', 'go', 'open']);
  });
});
