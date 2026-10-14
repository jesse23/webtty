import { describe, expect, test } from 'bun:test';
import * as barrel from '../ghostty-web';
import { WASM_PATH } from './support/wasm';

// The vendored layer's public barrel is the only path app code imports it through
// (ADR 060, ADR 061). Its runtime surface is pinned here so the splits behind the
// facades cannot drop or rename an export by accident.

describe('the ghostty-web barrel', () => {
  test('exports the same runtime names', () => {
    expect(Object.keys(barrel).sort()).toEqual([
      'AT_ONCE',
      'CanvasRenderer',
      'CellFlags',
      'DirtyState',
      'DisposableStore',
      'EventEmitter',
      'FRAME_MS',
      'FitAddon',
      'Ghostty',
      'Glide',
      'InputHandler',
      'Key',
      'KeyAction',
      'KeyEncoderOption',
      'LinkDetector',
      'Mods',
      'OSC8LinkProvider',
      'OfficialTerminal',
      'SelectionManager',
      'Terminal',
      'UrlRegexProvider',
      'easeOutCubic',
      'linear',
      'listen',
      'toDisposable',
      'watchDevicePixelRatio',
    ]);
  });

  test('loads the official wasm from a path, as the page does, and runs a terminal', async () => {
    const ghostty = await barrel.Ghostty.load(WASM_PATH);
    const term = ghostty.createTerminal(10, 2);
    expect(term).toBeInstanceOf(barrel.OfficialTerminal);
    term.write('hi\r\nthere');
    const text = (y: number) =>
      (term.getLine(y) ?? []).map((cell) => String.fromCodePoint(cell.codepoint || 32)).join('');
    expect(text(0).trimEnd()).toBe('hi');
    expect(text(1).trimEnd()).toBe('there');
    term.free();
  });
});
