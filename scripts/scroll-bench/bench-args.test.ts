import { describe, expect, test } from 'bun:test';
import { DEFAULT_CDP_PORT, DEFAULT_RUNS, parseBase, parseBenchArgs } from './bench-args';
import { INPUT_NAMES } from './inputs';

describe('parseBase', () => {
  test('a labelled URL keeps its label and origin', () => {
    expect(parseBase('after=http://localhost:3002/')).toEqual({
      label: 'after',
      url: 'http://localhost:3002',
    });
  });
  test('a bare URL is labelled by host and port', () => {
    expect(parseBase('http://localhost:3001')).toEqual({
      label: 'localhost:3001',
      url: 'http://localhost:3001',
    });
  });
  test('rejects what is not an http URL', () => {
    expect(() => parseBase('localhost')).toThrow('not a URL');
    expect(() => parseBase('a=ws://localhost:1')).toThrow('http or https');
  });
});

describe('parseBenchArgs', () => {
  test('defaults the inputs, runs and CDP port', () => {
    expect(parseBenchArgs(['--base', 'http://localhost:1', '--scenarios', 's.json'])).toEqual({
      bases: [{ label: 'localhost:1', url: 'http://localhost:1' }],
      scenariosFile: 's.json',
      inputs: INPUT_NAMES,
      runs: DEFAULT_RUNS,
      cdpPort: DEFAULT_CDP_PORT,
    });
  });

  test('reads every flag, and several bases', () => {
    const args = parseBenchArgs([
      '--base',
      'a=http://localhost:1',
      '--base',
      'b=http://localhost:2',
      '--scenarios',
      's.json',
      '--inputs',
      'wheel, trackpoint',
      '--runs',
      '3',
      '--cdp-port',
      '9444',
    ]);
    expect(args.bases.map((b) => b.label)).toEqual(['a', 'b']);
    expect(args.inputs).toEqual(['wheel', 'trackpoint']);
    expect(args.runs).toBe(3);
    expect(args.cdpPort).toBe(9444);
  });

  const bad: [string, string[], string][] = [
    ['no base', ['--scenarios', 's'], 'at least one server'],
    ['no scenarios', ['--base', 'http://h:1'], 'the scenarios file'],
    ['a flag without a value', ['--base'], 'needs a value'],
    ['an unknown flag', ['--fast', '1'], 'unknown flag --fast'],
    ['an unknown input', ['--inputs', 'touch'], 'unknown input touch'],
    ['zero runs', ['--runs', '0'], 'whole number'],
    [
      'a repeated label',
      ['--base', 'a=http://h:1', '--base', 'a=http://h:2', '--scenarios', 's'],
      'unique',
    ],
  ];
  for (const [name, argv, message] of bad) {
    test(`rejects ${name}`, () => expect(() => parseBenchArgs(argv)).toThrow(message));
  }
});
