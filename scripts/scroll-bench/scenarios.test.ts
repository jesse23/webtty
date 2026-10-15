import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import { expandCommand, loadScenarios, parseScenario, parseScenarios } from './scenarios';

const VARS = { repo: '/repo', bench: '/repo/scripts/scroll-bench' };

describe('parseScenario', () => {
  test('fills in the defaults', () => {
    expect(parseScenario({ name: 'seq', command: 'seq 1 5000' }, 0, VARS)).toEqual({
      name: 'seq',
      kind: 'scroll',
      command: 'seq 1 5000',
      waitMs: 3000,
      enter2: false,
      enter2WaitMs: 6000,
      direction: 'up',
      screen: 'normal',
    });
  });

  test('keeps given fields and expands placeholders', () => {
    const s = parseScenario(
      {
        name: 'stream',
        note: 'ignored',
        kind: 'stream',
        command: 'bash {bench}/stream.sh',
        waitMs: 100,
        enter2: true,
        enter2WaitMs: 0,
        direction: 'down',
        screen: 'alt',
      },
      0,
      VARS,
    );
    expect(s).toMatchObject({
      kind: 'stream',
      command: 'bash /repo/scripts/scroll-bench/stream.sh',
      waitMs: 100,
      enter2: true,
      enter2WaitMs: 0,
      direction: 'down',
      screen: 'alt',
    });
  });

  const bad: [string, unknown, string][] = [
    ['not an object', [], 'must be an object'],
    ['an unknown field', { name: 'a', command: 'x', wait: 1 }, 'unknown field wait'],
    ['an upper-case name', { name: 'Vim', command: 'vim' }, 'name must be'],
    ['an empty command', { name: 'a', command: ' ' }, 'command must be'],
    ['a bad kind', { name: 'a', command: 'x', kind: 'paint' }, 'kind: must be one of'],
    ['a bad direction', { name: 'a', command: 'x', direction: 'left' }, 'direction'],
    ['a negative wait', { name: 'a', command: 'x', waitMs: -1 }, 'waitMs'],
    ['a string enter2', { name: 'a', command: 'x', enter2: 'yes' }, 'enter2'],
  ];
  for (const [name, entry, message] of bad) {
    test(`rejects ${name}`, () => expect(() => parseScenario(entry, 3, VARS)).toThrow(message));
  }
});

describe('parseScenarios', () => {
  test('needs an array of uniquely named scenarios', () => {
    expect(() => parseScenarios({}, VARS)).toThrow('must be a JSON array');
    const dup = [
      { name: 'a', command: 'x' },
      { name: 'a', command: 'y' },
    ];
    expect(() => parseScenarios(dup, VARS)).toThrow('duplicate name a');
  });

  test('expandCommand replaces every placeholder', () => {
    expect(expandCommand('{repo} {bench} {repo}', VARS)).toBe(
      '/repo /repo/scripts/scroll-bench /repo',
    );
  });

  test('the example file parses, with a stream scenario', () => {
    const scenarios = loadScenarios(path.join(import.meta.dir, 'scenarios.example.json'), VARS);
    expect(scenarios.map((s) => s.name)).toContain('seq');
    const stream = scenarios.find((s) => s.kind === 'stream');
    expect(stream?.command).toBe('bash /repo/scripts/scroll-bench/stream.sh 40 120');
  });
});
