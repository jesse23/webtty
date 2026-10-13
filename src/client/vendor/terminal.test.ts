import { describe, expect, test } from 'bun:test';
import {
  cursorCellOffset,
  decscusrShape,
  deviceCellPixels,
  mouseCursorFor,
  scanDecscusr,
  TickPacer,
  type WheelAccumulator,
  wheelArrows,
  wheelSgr,
  wheelTicks,
} from './ghostty-web/terminal';
import type { ILink } from './ghostty-web/types';

describe('mouseCursorFor', () => {
  const link: ILink = {
    text: 'https://example.com',
    range: { start: { x: 0, y: 0 }, end: { x: 18, y: 0 } },
    activate: () => {},
  };

  test('uses the default arrow when no link is hovered', () => {
    expect(mouseCursorFor(undefined)).toBe('default');
  });

  test('uses the pointer over a link', () => {
    expect(mouseCursorFor(link)).toBe('pointer');
  });
});

describe('decscusrShape', () => {
  test('Ps 0 clears the app shape so the configured one shows', () => {
    expect(decscusrShape(0)).toBeUndefined();
  });

  test('Ps 1 — blinking block', () => {
    expect(decscusrShape(1)).toEqual({ style: 'block', blink: true });
  });

  test('Ps 2 — steady block', () => {
    expect(decscusrShape(2)).toEqual({ style: 'block', blink: false });
  });

  test('Ps 3 — blinking underline', () => {
    expect(decscusrShape(3)).toEqual({ style: 'underline', blink: true });
  });

  test('Ps 4 — steady underline', () => {
    expect(decscusrShape(4)).toEqual({ style: 'underline', blink: false });
  });

  test('Ps 5 — blinking bar', () => {
    expect(decscusrShape(5)).toEqual({ style: 'bar', blink: true });
  });

  test('Ps 6 — steady bar', () => {
    expect(decscusrShape(6)).toEqual({ style: 'bar', blink: false });
  });
});

describe('scanDecscusr', () => {
  test('reads Ps', () => {
    expect(scanDecscusr('\x1b[6 q')).toEqual({ ps: 6, carry: '' });
  });

  test('empty Ps is 0', () => {
    expect(scanDecscusr('\x1b[ q').ps).toBe(0);
  });

  test('no sequence yields no Ps', () => {
    expect(scanDecscusr('hello world')).toEqual({ ps: undefined, carry: '' });
  });

  test('out-of-range Ps is ignored', () => {
    expect(scanDecscusr('\x1b[7 q').ps).toBeUndefined();
    expect(scanDecscusr('\x1b[5 q\x1b[7 q').ps).toBe(5);
  });

  test('last sequence in a chunk wins', () => {
    expect(scanDecscusr('\x1b[2 q some output \x1b[5 q').ps).toBe(5);
  });

  test('finds a sequence embedded in output', () => {
    expect(scanDecscusr('text before\x1b[6 qtext after').ps).toBe(6);
  });

  test('ignores other CSI sequences ending in q', () => {
    expect(scanDecscusr('\x1b[>q\x1b[1q\x1b[0"q').ps).toBeUndefined();
  });

  test('carries a sequence split across chunks', () => {
    for (const [head, tail] of [
      ['ab\x1b', '[6 q'],
      ['ab\x1b[', '6 q'],
      ['ab\x1b[6', ' q'],
      ['ab\x1b[6 ', 'q'],
    ]) {
      const first = scanDecscusr(head);
      expect(first.ps).toBeUndefined();
      expect(first.carry).toBe(head.slice(2));
      expect(scanDecscusr(tail, first.carry)).toEqual({ ps: 6, carry: '' });
    }
  });

  test('carries nothing after a finished sequence or plain text', () => {
    expect(scanDecscusr('\x1b[6 q').carry).toBe('');
    expect(scanDecscusr('\x1b[6m').carry).toBe('');
    expect(scanDecscusr('\x1b[6 x').carry).toBe('');
  });
});

describe('wheelTicks', () => {
  const fresh = (): WheelAccumulator => ({ accum: 0, dir: 0 });
  const PIXEL = 0;
  const LINE = 1;
  const PAGE = 2;

  test('a line delta is one tick per event, down positive and up negative', () => {
    const acc = fresh();
    expect(wheelTicks(acc, { deltaY: 3, deltaMode: LINE }, 14, 1)).toBe(1);
    expect(wheelTicks(acc, { deltaY: -3, deltaMode: LINE }, 14, 1)).toBe(-1);
  });

  test('a page delta is one tick per event too', () => {
    expect(wheelTicks(fresh(), { deltaY: 1, deltaMode: PAGE }, 14, 1)).toBe(1);
  });

  test('speed above 1 sends several ticks per line event', () => {
    expect(wheelTicks(fresh(), { deltaY: 3, deltaMode: LINE }, 14, 3)).toBe(3);
  });

  test('speed below 1 accumulates across events', () => {
    const acc = fresh();
    expect(wheelTicks(acc, { deltaY: 3, deltaMode: LINE }, 14, 0.5)).toBe(0);
    expect(wheelTicks(acc, { deltaY: 3, deltaMode: LINE }, 14, 0.5)).toBe(1);
    expect(wheelTicks(acc, { deltaY: 3, deltaMode: LINE }, 14, 0.5)).toBe(0);
  });

  test('pixel deltas count one tick per cell height, ignoring speed', () => {
    const acc = fresh();
    expect(wheelTicks(acc, { deltaY: 7, deltaMode: PIXEL }, 14, 3)).toBe(0);
    expect(wheelTicks(acc, { deltaY: 7, deltaMode: PIXEL }, 14, 3)).toBe(1);
    expect(wheelTicks(acc, { deltaY: -42, deltaMode: PIXEL }, 14, 3)).toBe(-3);
  });

  test('a direction change drops the remainder', () => {
    const acc = fresh();
    expect(wheelTicks(acc, { deltaY: 10, deltaMode: PIXEL }, 14, 1)).toBe(0);
    expect(wheelTicks(acc, { deltaY: -10, deltaMode: PIXEL }, 14, 1)).toBe(0);
    expect(wheelTicks(acc, { deltaY: -4, deltaMode: PIXEL }, 14, 1)).toBe(-1);
    expect(wheelTicks(acc, { deltaY: 10, deltaMode: PIXEL }, 14, 1)).toBe(0);
  });
});

describe('wheelSgr', () => {
  test('scroll up is button 64 at the cell', () => {
    expect(wheelSgr(-1, 5, 3)).toBe('\x1b[<64;5;3M');
  });

  test('scroll down is button 65, one report per tick', () => {
    expect(wheelSgr(2, 1, 1)).toBe('\x1b[<65;1;1M\x1b[<65;1;1M');
  });
});

describe('wheelArrows', () => {
  const acc = (): WheelAccumulator => ({ accum: 0, dir: 0 });

  test('slow trackpad deltas add up to one arrow per line', () => {
    const a = acc();
    const sent = [3, 3, 3, 3, 3, 3].map((d) => wheelArrows(a, { deltaY: d, deltaMode: 0 }, 17, 40));
    expect(sent).toEqual([0, 0, 0, 0, 0, 1]);
  });

  test('a Firefox notch of 3 lines sends 3 arrows', () => {
    expect(wheelArrows(acc(), { deltaY: -3, deltaMode: 1 }, 17, 40)).toBe(-3);
  });

  test('a large delta is not capped', () => {
    expect(wheelArrows(acc(), { deltaY: 340, deltaMode: 0 }, 17, 40)).toBe(20);
  });

  test('page deltas scale by rows, and a direction change drops the remainder', () => {
    const a = acc();
    expect(wheelArrows(a, { deltaY: 1, deltaMode: 2 }, 17, 40)).toBe(40);
    expect(wheelArrows(a, { deltaY: 10, deltaMode: 0 }, 17, 40)).toBe(0);
    expect(wheelArrows(a, { deltaY: -10, deltaMode: 0 }, 17, 40)).toBe(0);
  });
});

describe('TickPacer', () => {
  function frames(run: (pacer: TickPacer, sent: string[], tick: (ms: number) => void) => void) {
    const g = globalThis as {
      requestAnimationFrame?: unknown;
      cancelAnimationFrame?: unknown;
      performance?: unknown;
    };
    const saved = [g.requestAnimationFrame, g.cancelAnimationFrame, g.performance];
    let now = 0;
    let pending: ((t: number) => void) | null = null;
    g.requestAnimationFrame = (cb: (t: number) => void) => {
      pending = cb;
      return 1;
    };
    g.cancelAnimationFrame = () => {
      pending = null;
    };
    g.performance = { now: () => now };
    const sent: string[] = [];
    try {
      run(new TickPacer((d) => sent.push(d)), sent, (ms) => {
        now += ms;
        const cb = pending;
        pending = null;
        cb?.(now);
      });
    } finally {
      [g.requestAnimationFrame, g.cancelAnimationFrame, g.performance] = saved;
    }
  }

  test('the first tick goes out on the first frame', () => {
    frames((pacer, sent, tick) => {
      pacer.push('A', -1, 1, 125);
      tick(1000 / 60);
      expect(sent).toEqual(['A']);
    });
  });

  test('a zero duration sends the ticks at once', () => {
    frames((pacer, sent) => {
      pacer.push('A', -1, 3, 0);
      expect(sent).toEqual(['AAA']);
    });
  });

  test('spreads ticks evenly over the duration, a few per frame', () => {
    frames((pacer, sent, tick) => {
      // 12 ticks over 50 ms, starting a frame early: 4 per 16.7 ms frame, so the
      // first frame sends 8 and the next the last 4.
      pacer.push('A', -1, 12, 50);
      expect(sent).toEqual([]);
      tick(1000 / 60);
      expect(sent).toEqual(['A'.repeat(8)]);
      tick(1000 / 60);
      expect(sent).toEqual(['A'.repeat(8), 'A'.repeat(4)]);
    });
  });

  test('a new event joins the ticks still queued', () => {
    frames((pacer, sent, tick) => {
      pacer.push('A', -1, 6, 50);
      tick(1000 / 60);
      pacer.push('B', -1, 6, 50);
      for (let i = 0; i < 6; i++) tick(1000 / 60);
      const all = sent.join('');
      expect(all.length).toBe(12);
      // Queued ticks go out with the latest event's sequence.
      expect(all.endsWith('B')).toBe(true);
    });
  });

  test('a zero-duration event flushes the queued ticks first', () => {
    frames((pacer, sent) => {
      pacer.push('A', 1, 6, 50);
      pacer.push('B', 1, 2, 0);
      expect(sent).toEqual(['BBBBBBBB']);
    });
  });

  test('a direction change drops the queued ticks', () => {
    frames((pacer, sent, tick) => {
      pacer.push('A', -1, 10, 100);
      tick(1000 / 60);
      const before = sent.join('').length;
      pacer.push('B', 1, 1, 0);
      expect(sent.join('').length).toBe(before + 1);
      expect(sent.at(-1)).toBe('B');
      tick(1000 / 60);
      tick(100);
      expect(sent.at(-1)).toBe('B');
    });
  });
});

describe('cursorCellOffset', () => {
  const grid = { cols: 80, rows: 24 };
  const cell = { width: 9, height: 18 };
  const canvas = { left: 0, top: 0 };

  test('puts the spot at the cursor cell', () => {
    expect(cursorCellOffset({ x: 10, y: 5 }, 0, grid, cell, canvas)).toEqual({
      left: 90,
      top: 90,
    });
  });

  test('offsets by the canvas position inside the padding', () => {
    expect(cursorCellOffset({ x: 0, y: 0 }, 0, grid, cell, { left: 12, top: 8 })).toEqual({
      left: 12,
      top: 8,
    });
  });

  test('moves down with the scrollback offset', () => {
    expect(cursorCellOffset({ x: 0, y: 5 }, 3, grid, cell, canvas).top).toBe(8 * 18);
  });

  test('stays on the last row once the cursor scrolls out of view', () => {
    expect(cursorCellOffset({ x: 0, y: 20 }, 100, grid, cell, canvas).top).toBe(23 * 18);
  });

  test('clamps a pending-wrap cursor to the last column', () => {
    expect(cursorCellOffset({ x: 80, y: 0 }, 0, grid, cell, canvas).left).toBe(79 * 9);
  });
});

describe('deviceCellPixels', () => {
  test('is the CSS cell at the device pixel ratio, in whole pixels', () => {
    expect(deviceCellPixels(9, 2)).toBe(18);
    expect(deviceCellPixels(8.4, 1.25)).toBe(11);
    expect(deviceCellPixels(19.2, 1.5)).toBe(29);
  });

  test('never reports less than one pixel', () => {
    expect(deviceCellPixels(0, 2)).toBe(1);
    expect(deviceCellPixels(0.2, 1)).toBe(1);
  });
});
