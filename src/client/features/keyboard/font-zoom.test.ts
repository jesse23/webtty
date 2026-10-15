import { describe, expect, test } from 'bun:test';
import {
  clampFontSize,
  type FontZoomStep,
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
  type ZoomKeyEvent,
  zoomedFontSize,
  zoomStepFor,
} from './font-zoom';

/** A keydown of `code` with Ctrl held unless the mods say otherwise. */
function key(code: string, mods: Partial<ZoomKeyEvent> = {}): ZoomKeyEvent {
  return { code, ctrlKey: true, metaKey: false, shiftKey: false, ...mods };
}

describe('clampFontSize', () => {
  test.each([
    [14, 14],
    [MIN_FONT_SIZE, 6],
    [MAX_FONT_SIZE, 32],
    [2, 6],
    [72, 32],
  ])('%d → %d', (size, expected) => {
    expect(clampFontSize(size)).toBe(expected);
  });
});

describe('zoomStepFor', () => {
  test.each<[string, ZoomKeyEvent, FontZoomStep | null]>([
    ['Ctrl+=', key('Equal'), 'in'],
    ['Ctrl++ (Shift+=)', key('Equal', { shiftKey: true }), 'in'],
    ['Cmd+=', key('Equal', { ctrlKey: false, metaKey: true }), 'in'],
    ['Ctrl+numpad +', key('NumpadAdd'), 'in'],
    ['Ctrl+-', key('Minus'), 'out'],
    ['Ctrl+_ (Shift+-)', key('Minus', { shiftKey: true }), null],
    ['Ctrl+numpad -', key('NumpadSubtract'), 'out'],
    ['Ctrl+numpad - with Shift', key('NumpadSubtract', { shiftKey: true }), 'out'],
    ['Ctrl+0', key('Digit0'), 'reset'],
    ['Ctrl+) (Shift+0)', key('Digit0', { shiftKey: true }), null],
    ['Ctrl+numpad 0', key('Numpad0'), 'reset'],
    ['= without Ctrl or Cmd', key('Equal', { ctrlKey: false }), null],
    ['Ctrl+another key', key('KeyA'), null],
  ])('%s', (_name, e, expected) => {
    expect(zoomStepFor(e)).toBe(expected);
  });
});

describe('zoomedFontSize', () => {
  test.each<[FontZoomStep, number, number, number]>([
    ['in', 14, 14, 15],
    ['in', 32, 14, 32],
    ['out', 14, 14, 13],
    ['out', 6, 14, 6],
    ['reset', 20, 14, 14],
    ['reset', 20, 2, 6],
    ['reset', 20, 72, 32],
  ])('%s from %d (configured %d) → %d', (step, current, configured, expected) => {
    expect(zoomedFontSize(step, current, configured)).toBe(expected);
  });
});
