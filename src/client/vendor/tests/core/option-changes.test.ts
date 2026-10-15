import { describe, expect, spyOn, test } from 'bun:test';
import { applyOptionChange, type OptionChangeHost } from '../../ghostty-web/core/option-changes';
import type { TerminalOptionValues } from '../../ghostty-web/core/options-proxy';

// What an option set after open() changes, on a host that logs each call.

const OPTIONS = {
  cursorStyle: 'bar',
  cursorBlink: true,
  fontSize: 18,
  fontFamily: 'serif',
  cols: 100,
  rows: 30,
} as const;

function host(opened = true) {
  const log: string[] = [];
  const target: OptionChangeHost = {
    options: () => OPTIONS,
    engine: () =>
      opened
        ? { setDefaultCursor: (style, blink) => void log.push(`cursor ${style} ${blink}`) }
        : undefined,
    renderer: () =>
      opened
        ? {
            setFontSize: (size) => void log.push(`size ${size}`),
            setFontFamily: (family) => void log.push(`family ${family}`),
          }
        : undefined,
    fontChanged: () => void log.push('font changed'),
    resize: (cols, rows) => void log.push(`resize ${cols}x${rows}`),
  };
  return { target, log };
}

describe('applyOptionChange', () => {
  test.each<[keyof TerminalOptionValues, string[]]>([
    ['cursorStyle', ['cursor bar true']],
    ['cursorBlink', ['cursor bar true']],
    ['fontSize', ['size 18', 'font changed']],
    ['fontFamily', ['family serif', 'font changed']],
    ['cols', ['resize 100x30']],
    ['rows', ['resize 100x30']],
    ['disableStdin', []],
    ['copyOnSelect', []],
    ['mouseScrollSpeed', []],
  ])('a change of %s applies %j', (key, applied) => {
    const { target, log } = host();
    applyOptionChange(key, 'new', 'old', target);
    expect(log).toEqual(applied);
  });

  test('setting the value an option already has does nothing', () => {
    const { target, log } = host();
    applyOptionChange('fontSize', 18, 18, target);
    expect(log).toEqual([]);
  });

  test('a theme change warns that it is not fully supported', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    const { target, log } = host();
    applyOptionChange('theme', {}, {}, target);
    const warnings = warn.mock.calls.length;
    warn.mockRestore();
    expect([warnings, log]).toEqual([1, []]);
  });

  test('without a renderer, font and theme changes do nothing; the size still resizes', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    const { target, log } = host(false);
    for (const key of ['fontSize', 'fontFamily', 'theme', 'cursorStyle', 'cols'] as const) {
      applyOptionChange(key, 1, 2, target);
    }
    const warnings = warn.mock.calls.length;
    warn.mockRestore();
    expect([warnings, log]).toEqual([0, ['resize 100x30']]);
  });
});
