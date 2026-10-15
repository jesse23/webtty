import { afterEach, describe, expect, test } from 'bun:test';
import type { Terminal } from '../../vendor/ghostty-web';
import {
  engineOf,
  openTerminal,
  rendererOf,
  type TerminalHarness,
} from '../../vendor/tests/support/terminal-harness';
import { scrollbackText } from '../../vendor/tests/support/terminal-text';
import { SmoothScroll } from './smooth-scroll';
import { WheelStream } from './wheel-stream';

// SmoothScroll over a whole vendored Terminal on the real engine (ADR 066): the view is
// kept by ghostty-web's own Viewport.pin and unpin, not a stand-in, and a glide running
// through output shows the same text frame by frame as one without it.

let h: TerminalHarness | undefined;

afterEach(() => {
  h?.close();
  h = undefined;
});

/** The view's top row text and the sub-line offset the renderer was asked to show. */
function view(term: Terminal): string {
  const engine = engineOf(term);
  const top = engine.getScrollbackLength() - Math.floor(term.viewportY);
  return `${scrollbackText(engine, top).trim()} +${rendererOf(term).requestedOffset}`;
}

/**
 * Scrolls a mouse wheel notch up from 30 lines back and returns the view after each frame,
 * writing `lines` new lines on the 3rd frame of the glide when given.
 */
async function glide(lines?: number): Promise<string[]> {
  h?.close();
  h = await openTerminal({ cols: 20, rows: 5, scrollbackLines: 1000 });
  const { term, clock } = h;
  for (let i = 0; i < 200; i++) term.write(`L${i}\r\n`);
  const stream = new WheelStream({ matchMedia: () => ({ matches: false }) });
  const scroll = new SmoothScroll(term, stream, {
    window: { devicePixelRatio: 1 },
    performance: { now: () => clock.now() },
  });
  term.scrollToLine(30);
  const wheel = { deltaX: 0, deltaY: -3, deltaMode: 1, timeStamp: clock.now() } as WheelEvent;
  expect(scroll.handleWheel(wheel)).toBe(true);
  const views: string[] = [];
  for (let frame = 0; frame < 30; frame++) {
    if (frame === 3 && lines) {
      let out = '';
      for (let i = 0; i < lines; i++) out += `new ${i}\r\n`;
      term.write(out);
      scroll.onOutput();
    }
    clock.advance(16);
    scroll.frame(clock.now());
    views.push(view(term));
  }
  scroll.dispose();
  return views;
}

describe('SmoothScroll on the real Viewport pin', () => {
  test('a glide through output shows the same text, frame by frame, as one without it', async () => {
    const still = await glide();
    const fed = await glide(7);
    expect(fed).toEqual(still);
    // It moved, eased in between whole lines, and came to rest
    expect(new Set(still).size).toBeGreaterThan(3);
    expect(still.at(-1)).toBe(`L${200 - 5 - 30 - 3 + 1} +0`);
  });
});
