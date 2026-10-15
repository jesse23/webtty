import { describe, expect, test } from 'bun:test';
import { createDrawingCanvas, ViewportClip } from '../../ghostty-web/render/viewport-clip';

/** A canvas whose style records each write. */
function canvas() {
  const writes: string[] = [];
  const style = new Proxy({} as Record<string, string>, {
    set: (t, key, value) => {
      t[key as string] = value;
      writes.push(`${String(key)}=${value}`);
      return true;
    },
  });
  return { canvas: { style } as unknown as HTMLCanvasElement, writes };
}

describe('createDrawingCanvas', () => {
  test('inserts a positioned canvas the mouse passes through before the element', () => {
    const inserted: unknown[] = [];
    const made = { style: {}, dataset: {} } as HTMLCanvasElement;
    const element = {
      parentNode: { insertBefore: (node: unknown, before: unknown) => inserted.push(node, before) },
    } as unknown as HTMLCanvasElement;
    const result = createDrawingCanvas({ createElement: () => made } as never, element);
    expect(result).toBe(made);
    expect({ ...made.style }).toEqual({
      position: 'absolute',
      pointerEvents: 'none',
      display: 'block',
    } as CSSStyleDeclaration);
    expect(made.dataset.edge).toBe('true');
    expect(inserted).toEqual([made, element]);
  });

  test('an element outside the document is left alone', () => {
    const made = { style: {}, dataset: {} } as HTMLCanvasElement;
    const element = { parentNode: null } as unknown as HTMLCanvasElement;
    expect(createDrawingCanvas({ createElement: () => made } as never, element)).toBe(made);
  });
});

describe('ViewportClip', () => {
  test('moves the canvas up and clips it to the rows in view, writing only changes', () => {
    const { canvas: c, writes } = canvas();
    const clip = new ViewportClip(c);
    // 4 rows in view of a 10-row canvas, from canvas row 3, 5 px down, 20 px rows
    clip.show(3, 5, 4, 10, 20);
    expect(writes).toEqual(['transform=translateY(-55px)', 'clipPath=inset(55px 0px 65px 0px)']);
    expect(clip.offset).toBe(5);
    clip.show(3, 5, 4, 10, 20);
    expect(writes.length).toBe(2);
    clip.show(3, 0, 4, 10, 20);
    expect(writes.slice(2)).toEqual([
      'transform=translateY(-60px)',
      'clipPath=inset(60px 0px 60px 0px)',
    ]);
  });

  test('the visible area is in device pixels, its last line below the part in view at an offset', () => {
    const { canvas: c } = canvas();
    const clip = new ViewportClip(c);
    clip.show(3, 5, 4, 10, 20);
    expect(clip.area(2, 20, 7)).toEqual({
      canvas: c,
      y: 110,
      height: 160,
      lastLine: 279,
      version: 7,
    });
  });
});
