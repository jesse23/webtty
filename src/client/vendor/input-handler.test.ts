import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ghostty } from './ghostty-web/ghostty';
import { InputHandler, isNewMouseCell, mouseMotionButton } from './ghostty-web/input-handler';

const WASM = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'ghostty-vt/ghostty-vt-small.wasm',
);

describe('mouseMotionButton', () => {
  test('encodes hover (no button held) as 35', () => {
    expect(mouseMotionButton(0)).toBe(35);
  });

  test('encodes a left-button drag as 32', () => {
    expect(mouseMotionButton(1)).toBe(32);
  });

  test('encodes a middle-button drag as 33', () => {
    expect(mouseMotionButton(2)).toBe(33);
  });

  test('encodes a right-button drag as 34', () => {
    expect(mouseMotionButton(4)).toBe(34);
  });

  test('reports the lowest button when several are held', () => {
    expect(mouseMotionButton(1 | 4)).toBe(32);
    expect(mouseMotionButton(2 | 4)).toBe(33);
  });
});

describe('isNewMouseCell', () => {
  test('reports the first motion when nothing was reported yet', () => {
    expect(isNewMouseCell(null, { col: 8, row: 4 })).toBe(true);
  });

  test('drops motion within the last reported cell', () => {
    expect(isNewMouseCell({ col: 8, row: 4 }, { col: 8, row: 4 })).toBe(false);
  });

  test('reports motion into a new column', () => {
    expect(isNewMouseCell({ col: 8, row: 4 }, { col: 9, row: 4 })).toBe(true);
  });

  test('reports motion into a new row', () => {
    expect(isNewMouseCell({ col: 8, row: 4 }, { col: 8, row: 5 })).toBe(true);
  });
});

describe('InputHandler wheel', () => {
  // The terminal's own wheel listener, paced, is the only wheel path: one here also fired
  // for a wheel over the padding, where the container is the target, and sent the tick
  // twice.
  test('sends nothing for a wheel event on the container, even with mouse tracking', async () => {
    const ghostty = await Ghostty.load(WASM);
    const listeners = new Map<string, ((e: object) => void)[]>();
    const container = {
      addEventListener: (type: string, listener: (e: object) => void) =>
        listeners.set(type, [...(listeners.get(type) ?? []), listener]),
      removeEventListener: () => {},
    } as unknown as HTMLElement;
    const sent: string[] = [];
    const handler = new InputHandler(
      ghostty,
      container,
      (data) => sent.push(data),
      () => {},
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        hasMouseTracking: () => true,
        hasSgrMouseMode: () => true,
        getCellDimensions: () => ({ width: 8, height: 16 }),
        getCanvasOffset: () => ({ left: 10, top: 10 }),
      },
    );
    const wheel = { deltaY: 40, clientX: 2, clientY: 2, preventDefault: () => {} };
    for (const listener of listeners.get('wheel') ?? []) listener(wheel);
    expect(sent).toEqual([]);
    handler.dispose();
  });
});
