import { describe, expect, test } from 'bun:test';
import {
  checkSizes,
  EXEMPT,
  limitFor,
  SOURCE_LIMIT,
  TEST_LIMIT,
  VENDOR_LIMIT,
} from './size-limits';

const lines = (count: number) => 'x\n'.repeat(count);
const V = 'src/client/vendor/ghostty-web/';

describe('limitFor', () => {
  const cases: [string, number][] = [
    ['src/client/output-ack.ts', SOURCE_LIMIT],
    ['src/client/index.ts', 20],
    ['src/client/app/start-client.ts', SOURCE_LIMIT],
    ['src/server/app.ts', SOURCE_LIMIT],
    ['scripts/build.ts', SOURCE_LIMIT],
    ['src/client/test-support/fake-socket.ts', SOURCE_LIMIT],
    ['src/client/output-ack.test.ts', TEST_LIMIT],
    [`${V}terminal.test.ts`, TEST_LIMIT],
    [`${V}glide.ts`, VENDOR_LIMIT],
    [`${V}render/cell-painter.ts`, VENDOR_LIMIT],
    [`${V}ghostty.ts`, 300],
    [`${V}terminal.ts`, 600],
    [`${V}renderer.ts`, 500],
    [`${V}input-handler.ts`, 300],
    [`${V}selection-manager.ts`, 300],
    [`${V}engine/official-terminal.ts`, 500],
    [`${V}engine/render-state.ts`, 700],
    [`${V}input/key-map.ts`, Number.POSITIVE_INFINITY],
    [`${V}input/key-types.ts`, Number.POSITIVE_INFINITY],
    [`${V}engine/official-layout.ts`, Number.POSITIVE_INFINITY],
  ];
  for (const [file, max] of cases) {
    test(`${file} → ${max}`, () => expect(limitFor(file).max).toBe(max));
  }

  test('every exemption says why', () => {
    for (const [file, reason] of Object.entries(EXEMPT)) {
      expect(limitFor(file).reason).toBe(reason);
      expect(reason.length).toBeGreaterThan(10);
    }
  });
});

describe('checkSizes', () => {
  test('a file at its limit passes; one line more fails with its count', () => {
    const violations = checkSizes([
      { path: 'src/client/at-limit.ts', text: lines(SOURCE_LIMIT) },
      { path: 'src/client/over-limit.ts', text: lines(SOURCE_LIMIT + 1) },
    ]);
    expect(violations).toEqual([
      {
        rule: 'size',
        file: 'src/client/over-limit.ts',
        key: 'size src/client/over-limit.ts',
        message: 'src/client/over-limit.ts has 301 lines, over its limit of 300 (source)',
        lines: 301,
      },
    ]);
  });

  test('an exempt data table has no limit', () => {
    expect(checkSizes([{ path: `${V}input/key-map.ts`, text: lines(5000) }])).toEqual([]);
  });

  test('a test file may reach the test limit', () => {
    expect(checkSizes([{ path: 'src/a.test.ts', text: lines(TEST_LIMIT) }])).toEqual([]);
    expect(checkSizes([{ path: 'src/a.test.ts', text: lines(TEST_LIMIT + 1) }])).toHaveLength(1);
  });
});
