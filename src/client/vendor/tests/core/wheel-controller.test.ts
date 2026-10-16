import { describe, expect, test } from 'bun:test';
import { RecordingTarget } from '../../../test-support/recording-target';
import type { WheelEngine, WheelHost } from '../../ghostty-web/core/host-types';
import { MouseController } from '../../ghostty-web/core/mouse-controller';
import { WheelController } from '../../ghostty-web/core/wheel-controller';
import type { GhosttyTerminal } from '../../ghostty-web/ghostty';
import { AT_ONCE, type Pace } from '../../ghostty-web/glide';
import { loadGhostty } from '../support/wasm';

// Wheel routing: the zoom cancel, the embedder's handler, scroll ticks to an app that
// tracks the mouse, encoded by Ghostty (ADR 049), and arrow keys on the alternate screen
// (ADR 045), with a recording pacer and container.

interface Options {
  engine?: WheelEngine;
  cellHeight?: number;
  hasCanvas?: boolean;
  /** What the mouse encoder returns, `<button>` by default. */
  encoded?: string;
}

/** A controller on a recording container; `pushed` logs the pacer's queue. */
function wheelOn(options: Options = {}) {
  const pushed: [string, number, number, Pace][] = [];
  const log: string[] = [];
  const container = new RecordingTarget('container');
  const host: WheelHost = {
    engine: () => options.engine,
    cellHeight: () => ('cellHeight' in options ? options.cellHeight : 20),
    hasCanvas: () => options.hasCanvas ?? true,
    rows: () => 10,
    mouseScrollSpeed: () => 1,
    encodeMouse: (event) => options.encoded ?? `<${event.button}>`,
    send: (data) => log.push(data),
  };
  const pacer = {
    push: (seq: string, dir: number, count: number, pace: Pace) =>
      pushed.push([seq, dir, count, pace]),
    cancel: () => log.push('cancel'),
    answered: () => log.push('answered'),
  };
  const controller = new WheelController(host, pacer);
  controller.attach(container as unknown as HTMLElement);
  return { controller, container, pushed, log };
}

/** A line-mode wheel event of `deltaY` lines; `cancelled` and `stopped` report what it did. */
function wheelEvent(deltaY: number, mods: object = {}) {
  const result = { cancelled: false, stopped: false };
  const event = {
    type: 'wheel',
    deltaY,
    deltaMode: 1,
    clientX: 1,
    clientY: 1,
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    preventDefault: () => {
      result.cancelled = true;
    },
    stopPropagation: () => {
      result.stopped = true;
    },
    ...mods,
  } as unknown as WheelEvent;
  return { event, result };
}

/** An engine stand-in in one state. */
function engineIn(state: { tracking?: boolean; alternate?: boolean; appCursor?: boolean }) {
  return {
    hasMouseTracking: () => state.tracking ?? false,
    isAlternateScreen: () => state.alternate ?? false,
    getMode: (mode: number) => mode === 1 && (state.appCursor ?? false),
  } as WheelEngine;
}

describe('WheelController listener', () => {
  test('attach adds one capture, non-passive wheel listener; dispose removes it once', () => {
    const { controller, container, log } = wheelOn();
    expect(container.added.map((r) => [r.type, r.capture, r.passive])).toEqual([
      ['wheel', true, false],
    ]);
    controller.dispose();
    expect(container.active).toEqual([]);
    expect(log).toEqual(['cancel']);
    controller.dispose();
    expect(container.removed).toHaveLength(1);
  });

  test('the default pacer sends through the host', () => {
    const sent: string[] = [];
    const controller = new WheelController({
      engine: () => engineIn({ alternate: true }),
      cellHeight: () => 20,
      hasCanvas: () => true,
      rows: () => 10,
      mouseScrollSpeed: () => 1,
      encodeMouse: () => '',
      send: (data) => sent.push(data),
    });
    controller.handle(wheelEvent(2).event);
    expect(sent).toEqual(['\x1b[B\x1b[B']);
    controller.dispose();
  });
});

describe('WheelController routing', () => {
  // A cancelled wheel event makes Chrome hold the gesture's next one until the page has
  // handled it: only zooming (pinch, ctrl+wheel) is cancelled (ADR 045).
  test('a scroll is not cancelled; pinch and ctrl+wheel are; neither propagates', () => {
    const { container } = wheelOn();
    const scroll = wheelEvent(3);
    container.dispatch(scroll.event);
    expect(scroll.result).toEqual({ cancelled: false, stopped: true });
    const zoom = wheelEvent(3, { ctrlKey: true });
    container.dispatch(zoom.event);
    expect(zoom.result).toEqual({ cancelled: true, stopped: true });
  });

  test("the embedder's handler takes an event by returning true", () => {
    const t = wheelOn({ engine: engineIn({ alternate: true }) });
    const seen: number[] = [];
    t.controller.setCustomHandler((e) => {
      seen.push(e.deltaY);
      return e.deltaY > 0;
    });
    t.controller.handle(wheelEvent(2).event);
    t.controller.handle(wheelEvent(-1).event);
    expect(seen).toEqual([2, -1]);
    expect(t.pushed.map(([seq, dir, count]) => [seq, dir, count])).toEqual([['\x1b[A', -1, 1]]);
  });

  test('ticks go to an app that tracks the mouse, paced as the embedder says', () => {
    const t = wheelOn({ engine: engineIn({ tracking: true, alternate: true }) });
    const pace: Pace = { duration: 100 };
    t.controller.setPace(() => pace);
    // Pixel deltas count one tick per 20 px cell
    t.controller.handle(wheelEvent(-40, { deltaMode: 0 }).event);
    t.controller.handle(wheelEvent(60, { deltaMode: 0 }).event);
    expect(t.pushed).toEqual([
      ['<four>', -1, 2, pace],
      ['<five>', 1, 3, pace],
    ]);
  });

  test('no ticks before open(), nor while the encoder sends nothing', () => {
    const tracking = engineIn({ tracking: true });
    for (const options of [{ cellHeight: undefined }, { hasCanvas: false }]) {
      const t = wheelOn({ engine: tracking, ...options });
      t.controller.handle(wheelEvent(3).event);
      expect(t.pushed).toEqual([]);
    }
    const silent = wheelOn({ engine: tracking, encoded: '' });
    silent.controller.handle(wheelEvent(3).event);
    expect(silent.pushed).toEqual([]);
  });

  test('the alternate screen gets arrows, ESC O under application cursor keys', () => {
    const plain = wheelOn({ engine: engineIn({ alternate: true }) });
    plain.controller.handle(wheelEvent(-3).event);
    expect(plain.pushed).toEqual([['\x1b[A', -1, 3, AT_ONCE]]);
    const app = wheelOn({ engine: engineIn({ alternate: true, appCursor: true }) });
    app.controller.handle(wheelEvent(2).event);
    expect(app.pushed).toEqual([['\x1bOB', 1, 2, AT_ONCE]]);
  });

  test('arrows count 20 px cells before open(), and a part line sends nothing yet', () => {
    const t = wheelOn({ engine: engineIn({ alternate: true }), cellHeight: undefined });
    const pixels = (deltaY: number) => wheelEvent(deltaY, { deltaMode: 0 }).event;
    t.controller.handle(pixels(30));
    t.controller.handle(pixels(10));
    expect(t.pushed.map(([seq, dir, count]) => [seq, dir, count])).toEqual([
      ['\x1b[B', 1, 1],
      ['\x1b[B', 1, 1],
    ]);
  });

  test('the normal screen scrollback is left to the embedder', () => {
    for (const engine of [engineIn({}), undefined]) {
      const t = wheelOn({ engine });
      t.controller.handle(wheelEvent(3).event);
      expect(t.pushed).toEqual([]);
    }
  });
});

describe('WheelController in mouse-tracking apps', () => {
  // A 10 px x 20 px CSS cell at DPR 1, the grid at (5, 5) in a container at (0, 0); the
  // ticks are encoded by a MouseController on a real engine.
  async function wheelTerm(modes: string) {
    const ghostty = await loadGhostty();
    const wasmTerm: GhosttyTerminal = ghostty.createTerminal(40, 10);
    wasmTerm.write(modes);
    const mouse = new MouseController({
      element: () =>
        ({
          getBoundingClientRect: () => ({ left: 0, top: 0, right: 410, bottom: 210 }),
        }) as HTMLElement,
      canvas: () => ({ getBoundingClientRect: () => ({ left: 5, top: 5 }) }) as HTMLCanvasElement,
      engine: () => wasmTerm,
      renderer: () => ({
        charWidth: 10,
        charHeight: 20,
        scrollOffset: 0,
        getMetrics: () => ({ width: 10, height: 20 }),
        setHoveredLinkRange: () => {},
      }),
      links: () => undefined,
      selection: () => undefined,
      rows: () => 10,
      cols: () => 40,
      viewportY: () => 0,
      cellPixelSize: () => ({ width: 10, height: 20 }),
      rightClickBehavior: () => 'contextMenu',
      dragScrollbar: () => false,
      requestPaste: () => {},
    });
    const sent: string[] = [];
    const wheel = new WheelController({
      engine: () => wasmTerm,
      cellHeight: () => 20,
      hasCanvas: () => true,
      rows: () => 10,
      mouseScrollSpeed: () => 1,
      encodeMouse: (event) => mouse.encode(event),
      send: (data) => sent.push(data),
    });
    // The app answers each event's ticks at once, so the next ones go (ADR 069)
    const send = (deltaY: number, clientX: number, clientY: number, mods: object = {}) => {
      wheel.handle(wheelEvent(deltaY, { clientX, clientY, ...mods }).event);
      wheel.answered();
    };
    return { sent, send, free: () => wasmTerm.free() };
  }

  test('sends buttons 4/5 at the pointer cell in SGR, with modifiers', async () => {
    const { sent, send, free } = await wheelTerm('\x1b[?1000h\x1b[?1006h');
    send(-3, 5 + 10 * 6 + 1, 5 + 20 * 3 + 1);
    send(3, 5 + 10 * 6 + 1, 5 + 20 * 3 + 1, { altKey: true });
    expect(sent).toEqual(['\x1b[<64;7;4M', '\x1b[<73;7;4M']);
    free();
  });

  test('follows the format: X10 bytes without 1006, nothing in X10 mode 9', async () => {
    const x10 = await wheelTerm('\x1b[?1000h');
    x10.send(3, 6, 6);
    expect(x10.sent).toEqual(['\x1b[Ma!!']);
    x10.free();
    const mode9 = await wheelTerm('\x1b[?9h');
    mode9.send(3, 6, 6);
    expect(mode9.sent).toEqual([]);
    mode9.free();
  });
});
