import { describe, expect, test } from 'bun:test';
import { type Allowlist, applyAllowlist, EMPTY_ALLOWLIST } from './ratchet';
import { RATCHET_ALLOWLIST } from './ratchet-allowlist';
import type { SourceFile, Violation } from './source-file';

const sized = (file: string, lines: number): Violation => ({
  rule: 'size',
  file,
  key: `size ${file}`,
  message: `${file} is big`,
  lines,
});
const broken = (key: string): Violation => ({
  rule: 'vendor-deep',
  file: key.split(' ')[1],
  key,
  message: key,
});
const files = (...entries: [string, number][]): SourceFile[] =>
  entries.map(([path, count]) => ({ path, text: 'x\n'.repeat(count) }));

const allow = (overrides: Partial<Allowlist>): Allowlist => ({
  ...EMPTY_ALLOWLIST,
  strict: false,
  ...overrides,
});

describe('applyAllowlist', () => {
  test('an empty allowlist keeps every violation', () => {
    const found = [sized('src/a.ts', 400), broken('vendor-deep src/b.ts -> x')];
    expect(applyAllowlist(found, [], EMPTY_ALLOWLIST)).toEqual(found);
  });

  test('a listed file at or under its count passes', () => {
    const list = allow({ sizes: { 'src/a.ts': { lines: 400, step: 'S' } } });
    expect(applyAllowlist([sized('src/a.ts', 400)], [], list)).toEqual([]);
    expect(applyAllowlist([sized('src/a.ts', 350)], [], list)).toEqual([]);
  });

  test('a listed file that grew fails and names its step', () => {
    const list = allow({ sizes: { 'src/a.ts': { lines: 400, step: 'step S' } } });
    const [violation] = applyAllowlist([sized('src/a.ts', 401)], [], list);
    expect(violation.rule).toBe('size');
    expect(violation.message).toBe(
      'src/a.ts grew from 400 to 401 lines; an allowlisted file may only shrink (step S)',
    );
  });

  test('a listed rule break passes', () => {
    const list = allow({ rules: { 'vendor-deep src/b.ts -> x': 'S' } });
    expect(applyAllowlist([broken('vendor-deep src/b.ts -> x')], [], list)).toEqual([]);
  });

  test('a missing or fixed entry is tolerated while the branches are apart', () => {
    const list = allow({
      sizes: { 'src/gone.ts': { lines: 400, step: 'S' } },
      rules: { 'vendor-deep src/c.ts -> x': 'S' },
    });
    expect(applyAllowlist([], files(), list)).toEqual([]);
  });

  describe('strict', () => {
    const strict = (overrides: Partial<Allowlist>): Allowlist => ({
      ...EMPTY_ALLOWLIST,
      ...overrides,
    });

    test('a missing file is stale', () => {
      const list = strict({ sizes: { 'src/gone.ts': { lines: 400, step: 'S' } } });
      expect(applyAllowlist([], files(), list).map((v) => v.message)).toEqual([
        "allowlist entry 'size src/gone.ts' names a missing file",
      ]);
    });

    test('a file within its limit is stale', () => {
      const list = strict({ sizes: { 'src/a.ts': { lines: 400, step: 'S' } } });
      expect(applyAllowlist([], files(['src/a.ts', 120]), list).map((v) => v.message)).toEqual([
        "allowlist entry 'size src/a.ts' is within its limit now (120 lines)",
      ]);
    });

    test('a file that shrank must lower its count', () => {
      const list = strict({ sizes: { 'src/a.ts': { lines: 400, step: 'S' } } });
      const found = [sized('src/a.ts', 350)];
      expect(applyAllowlist(found, files(['src/a.ts', 350]), list).map((v) => v.message)).toEqual([
        "allowlist entry 'size src/a.ts' shrank to 350 lines; lower the count",
      ]);
    });

    test('a file at its count is not stale', () => {
      const list = strict({ sizes: { 'src/a.ts': { lines: 400, step: 'S' } } });
      expect(applyAllowlist([sized('src/a.ts', 400)], files(['src/a.ts', 400]), list)).toEqual([]);
    });

    test('a rule entry matching nothing is stale', () => {
      const list = strict({ rules: { 'vendor-deep src/b.ts -> x': 'S' } });
      const [violation] = applyAllowlist([], [], list);
      expect(violation).toEqual({
        rule: 'stale-allowlist',
        file: 'src/b.ts',
        key: 'stale-allowlist vendor-deep src/b.ts -> x',
        message: "allowlist entry 'vendor-deep src/b.ts -> x' matches no violation",
      });
    });
  });
});

describe('RATCHET_ALLOWLIST', () => {
  test('tolerates missing entries until the branches merge', () => {
    expect(RATCHET_ALLOWLIST.strict).toBe(false);
  });

  test('every entry names the step that removes it', () => {
    for (const entry of Object.values(RATCHET_ALLOWLIST.sizes)) expect(entry.step).not.toBe('');
    for (const step of Object.values(RATCHET_ALLOWLIST.rules)) expect(step).not.toBe('');
  });
});
