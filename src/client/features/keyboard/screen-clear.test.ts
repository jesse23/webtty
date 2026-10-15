import { describe, expect, test } from 'bun:test';
import { screenClearer } from './screen-clear';

describe('screenClearer', () => {
  function parts(clears: boolean) {
    const log: string[] = [];
    const clear = screenClearer(
      {
        clearScreen: () => {
          log.push('term.clearScreen');
          return clears;
        },
      },
      { clear: () => log.push('graphics.clear') },
      { onOutput: () => log.push('smoothScroll.onOutput') },
    );
    return { log, clear };
  }

  test('clears the screen, then the placements, then the sub-line offset', () => {
    const { log, clear } = parts(true);
    expect(clear()).toBe(true);
    expect(log).toEqual(['term.clearScreen', 'graphics.clear', 'smoothScroll.onOutput']);
  });

  test('does nothing more when the terminal does not clear (the alternate screen)', () => {
    const { log, clear } = parts(false);
    expect(clear()).toBe(false);
    expect(log).toEqual(['term.clearScreen']);
  });
});
