import { describe, expect, test } from 'bun:test';
import { ManualClock } from '../../../test-support/manual-clock';
import { RecordingTarget } from '../../../test-support/recording-target';
import { BufferNamespace } from '../../ghostty-web/buffer';
import type {
  LinkSource,
  MenuSelection,
  MouseEngine,
  MouseHost,
  MouseRenderer,
} from '../../ghostty-web/core/host-types';
import { browserTimeouts, MouseController } from '../../ghostty-web/core/mouse-controller';
import { LinkDetector } from '../../ghostty-web/link-detector';
import type { ILink } from '../../ghostty-web/link-types';
import type { RightClickBehavior } from '../../ghostty-web/mouse-route';
import { OSC8LinkProvider } from '../../ghostty-web/providers/osc8-link-provider';
import { loadGhostty } from '../support/wasm';

// The terminal's mouse: the link hover, throttled to one lookup per 16 ms, link clicks,
// the mouse report encoder (ADR 049) and the right-click route (ADR 051), on a recording
// container, a hand-run clock and, where the engine matters, a real one.

/** A link over columns 2-5 of buffer row 1; `log` records its hover and activation. */
function fakeLink(log: string[], name = 'link'): ILink {
  return {
    text: name,
    range: { start: { x: 2, y: 1 }, end: { x: 5, y: 1 } },
    activate: () => log.push(`activate ${name}`),
    hover: (on) => log.push(`hover ${name} ${on}`),
  };
}

interface Options {
  engine?: MouseEngine;
  links?: LinkSource;
  selection?: MenuSelection;
  rightClickBehavior?: RightClickBehavior;
  dragging?: boolean;
  opened?: boolean;
}

/**
 * A controller on an 8 x 16 px cell grid of 30 x 4 at the client origin, attached to a
 * recording container; `log` collects what it does to the host.
 */
function mouse(options: Options = {}) {
  const log: string[] = [];
  const clock = new ManualClock();
  const container = new RecordingTarget('container');
  const element = {
    style: { cursor: '' },
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 240, bottom: 64 }),
  };
  const canvas = { style: { cursor: '' }, getBoundingClientRect: () => ({ left: 0, top: 0 }) };
  const renderer: MouseRenderer = {
    charWidth: 8,
    charHeight: 16,
    scrollOffset: 0,
    getMetrics: () => ({ width: 8, height: 16 }),
    setHoveredLinkRange: (range) => log.push(`underline ${JSON.stringify(range)}`),
  };
  const engine =
    options.engine ??
    ({ getScrollbackLength: () => 0, hasMouseTracking: () => false } as MouseEngine);
  const opened = options.opened ?? true;
  const host: MouseHost = {
    element: () => (opened ? (element as unknown as HTMLElement) : undefined),
    canvas: () => (opened ? (canvas as unknown as HTMLCanvasElement) : undefined),
    engine: () => (opened ? engine : undefined),
    renderer: () => (opened ? renderer : undefined),
    links: () => options.links,
    selection: () => options.selection,
    rows: () => 4,
    cols: () => 30,
    viewportY: () => 0,
    cellPixelSize: () => (opened ? { width: 8, height: 16 } : null),
    rightClickBehavior: () => options.rightClickBehavior ?? 'contextMenu',
    dragScrollbar: () => {
      if (!options.dragging) return false;
      log.push('drag');
      return true;
    },
    requestPaste: () => log.push('paste'),
  };
  const controller = new MouseController(host, clock);
  controller.attach(container as unknown as HTMLElement);
  const move = (clientX: number, clientY: number) =>
    container.dispatch({ type: 'mousemove', clientX, clientY } as unknown as Event);
  return { controller, container, clock, log, element, canvas, move };
}

/** A LinkSource whose every lookup is logged and finds `link`. */
function lookups(log: string[], link?: ILink): LinkSource {
  return {
    getLinkAt: async (col, row) => {
      log.push(`lookup ${col},${row}`);
      return link;
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('MouseController listeners', () => {
  test('attach adds the six listeners in open() order; dispose removes them, once', () => {
    const { controller, container } = mouse();
    const rows = container.added.map((r) => `${r.type}${r.capture ? ' capture' : ''}`);
    expect(rows).toEqual([
      'mousemove',
      'mouseleave',
      'click',
      'mousedown capture',
      'keydown capture',
      'contextmenu capture',
    ]);
    controller.dispose();
    expect(container.active).toEqual([]);
    expect(container.removed).toHaveLength(6);
    controller.dispose();
    expect(container.removed).toHaveLength(6);
  });

  test('dispose drops a throttled move', async () => {
    const log: string[] = [];
    const t = mouse({ links: lookups(log) });
    t.move(1, 1);
    t.move(9, 1);
    expect(t.clock.pending.timers).toBe(1);
    t.controller.dispose();
    expect(t.clock.pending.timers).toBe(0);
    t.clock.advance(100);
    expect(log).toEqual(['lookup 0,0']);
  });
});

describe('MouseController link hover', () => {
  test('looks a link up at once, then at most once per 16 ms, for the last move', () => {
    const log: string[] = [];
    const t = mouse({ links: lookups(log) });
    t.move(1, 1);
    t.move(9, 1);
    t.move(17, 1);
    expect(log).toEqual(['lookup 0,0']);
    t.clock.advance(15);
    expect(log).toEqual(['lookup 0,0']);
    t.clock.advance(1);
    expect(log).toEqual(['lookup 0,0', 'lookup 2,0']);
    t.clock.advance(16);
    t.move(25, 17);
    expect(log).toEqual(['lookup 0,0', 'lookup 2,0', 'lookup 3,1']);
  });

  test('a scrollbar drag takes the move; nothing is looked up before open()', () => {
    const log: string[] = [];
    const dragging = mouse({ links: lookups(log), dragging: true });
    dragging.move(1, 1);
    expect(dragging.log).toEqual(['drag']);
    const closed = mouse({ links: lookups(log), opened: false });
    closed.move(1, 1);
    expect(log).toEqual([]);
  });

  test('a new link gets the hover, the pointer and its underline; leaving clears them', async () => {
    const log: string[] = [];
    const t = mouse({ links: lookups(log, fakeLink(log)) });
    t.move(17, 17);
    await settle();
    expect(t.element.style.cursor).toBe('pointer');
    expect(t.canvas.style.cursor).toBe('pointer');
    expect(log).toEqual(['lookup 2,1', 'hover link true']);
    expect(t.log).toEqual(['underline {"startX":2,"startY":1,"endX":5,"endY":1}']);
    // The same link again changes nothing
    t.clock.advance(16);
    t.move(25, 17);
    await settle();
    expect(t.log).toHaveLength(1);
    t.container.dispatch({ type: 'mouseleave' });
    expect(log.at(-1)).toBe('hover link false');
    expect(t.log.at(-1)).toBe('underline null');
    expect(t.element.style.cursor).toBe('default');
    expect(t.canvas.style.cursor).toBe('default');
  });

  test('a failed lookup is logged, not thrown', async () => {
    const warn = console.warn;
    const warned: unknown[] = [];
    console.warn = (...args: unknown[]) => warned.push(args[0]);
    try {
      const t = mouse({ links: { getLinkAt: () => Promise.reject(new Error('no')) } });
      t.move(1, 1);
      await settle();
      expect(warned).toEqual(['Link detection error:']);
    } finally {
      console.warn = warn;
    }
  });

  // The engine's hyperlink_id is a 1-bit "has a link" flag, so every OSC 8 cell carries
  // the same value: the hover is the hovered link's range, never an id.
  test('hovering an OSC 8 link gives the renderer that link range only', async () => {
    const ghostty = await loadGhostty();
    const wasmTerm = ghostty.createTerminal(30, 4);
    wasmTerm.write('\x1b]8;;https://a/\x1b\\first\x1b]8;;\x1b\\\r\n');
    wasmTerm.write('xx \x1b]8;;https://b/\x1b\\second\x1b]8;;\x1b\\');
    const term = { buffer: new BufferNamespace({ wasmTerm }), wasmTerm };
    const links = new LinkDetector(term);
    links.registerProvider(new OSC8LinkProvider(term));
    const t = mouse({ links, engine: wasmTerm });
    // Over "second", on row 1
    t.move(5 * 8 + 1, 16 + 1);
    await settle();
    expect(t.log).toEqual(['underline {"startX":3,"startY":1,"endX":8,"endY":1}']);
    wasmTerm.free();
  });
});

describe('MouseController link clicks', () => {
  /** Clicks at a cell with `mods`; whether the click was cancelled. */
  async function click(t: ReturnType<typeof mouse>, mods: object = {}) {
    let cancelled = false;
    t.container.dispatch({
      type: 'click',
      clientX: 17,
      clientY: 17,
      ctrlKey: false,
      metaKey: false,
      ...mods,
      preventDefault: () => {
        cancelled = true;
      },
    } as unknown as Event);
    await settle();
    return cancelled;
  }

  test('activates the link under the click, cancelling it with Ctrl or Cmd', async () => {
    const log: string[] = [];
    const t = mouse({ links: lookups(log, fakeLink(log)) });
    expect(await click(t)).toBe(false);
    expect(await click(t, { ctrlKey: true })).toBe(true);
    expect(await click(t, { metaKey: true })).toBe(true);
    expect(log.filter((l) => l.startsWith('activate'))).toHaveLength(3);
  });

  test('a click on no link does nothing', async () => {
    const log: string[] = [];
    expect(await click(mouse({ links: lookups(log) }), { ctrlKey: true })).toBe(false);
    expect(await click(mouse(), { ctrlKey: true })).toBe(false);
  });
});

describe('MouseController encode', () => {
  test('encodes at the pointer cell in the app mode, and is empty before open()', async () => {
    const ghostty = await loadGhostty();
    const wasmTerm = ghostty.createTerminal(30, 4);
    wasmTerm.write('\x1b[?1000h\x1b[?1006h');
    const report = {
      action: 'press',
      button: 'left',
      mods: 0,
      clientX: 8 * 6 + 1,
      clientY: 16 * 2 + 1,
      anyButtonPressed: false,
    } as const;
    expect(mouse({ engine: wasmTerm }).controller.encode(report)).toBe('\x1b[<0;7;3M');
    expect(mouse({ engine: wasmTerm, opened: false }).controller.encode(report)).toBe('');
    wasmTerm.free();
  });
});

describe('MouseController right-click', () => {
  // Every contextmenu goes through one handler: the app's right button cancels the menu,
  // and otherwise rightClickBehavior decides (ADR 051).
  async function setup(rightClickBehavior: RightClickBehavior) {
    const ghostty = await loadGhostty();
    const wasmTerm = ghostty.createTerminal(20, 2);
    wasmTerm.write('hello');
    const calls: string[] = [];
    let selection = '';
    const t = mouse({
      engine: wasmTerm,
      rightClickBehavior,
      selection: {
        getSelection: () => selection,
        copySelection: () => {
          calls.push(`copy ${selection}`);
          return true;
        },
        clearSelection: () => {
          calls.push('clear');
          selection = '';
        },
        prepareContextMenu: () => calls.push('menu'),
      },
    });
    t.log.length = 0;
    /** A right-click (press, then menu), or a keyboard menu; whether the menu was cancelled. */
    const menu = (opts: { shiftKey?: boolean; keyboard?: boolean } = {}) => {
      let cancelled = false;
      if (opts.keyboard) t.container.dispatch({ type: 'keydown' });
      else t.container.dispatch({ type: 'mousedown', button: 2, ctrlKey: false } as never);
      t.container.dispatch({
        type: 'contextmenu',
        button: opts.keyboard ? 0 : 2,
        shiftKey: opts.shiftKey ?? false,
        clientX: 1,
        clientY: 1,
        preventDefault: () => {
          cancelled = true;
        },
      } as unknown as Event);
      return cancelled;
    };
    return {
      menu,
      calls,
      pastes: () => t.log.filter((l) => l === 'paste').length,
      select: (text: string) => {
        selection = text;
      },
      track: (on: boolean) => wasmTerm.write(on ? '\x1b[?1000h' : '\x1b[?1000l'),
      free: () => wasmTerm.free(),
    };
  }

  test('contextMenu shows the menu; while the app tracks the mouse only Shift or the keyboard do', async () => {
    const t = await setup('contextMenu');
    expect(t.menu()).toBe(false);
    t.track(true);
    expect(t.menu()).toBe(true);
    expect(t.menu({ shiftKey: true })).toBe(false);
    expect(t.menu({ keyboard: true })).toBe(false);
    expect(t.calls).toEqual(['menu', 'menu', 'menu']);
    t.free();
  });

  test('copyPaste copies and clears a selection, or shows the menu without one', async () => {
    const t = await setup('copyPaste');
    expect(t.menu()).toBe(false);
    t.select('hello');
    expect(t.menu()).toBe(true);
    expect(t.calls).toEqual(['menu', 'copy hello', 'clear']);
    t.track(true);
    t.select('hello');
    expect(t.menu()).toBe(true);
    expect(t.calls.length).toBe(3);
    t.free();
  });

  test('paste asks for a paste with no menu; none does nothing', async () => {
    const p = await setup('paste');
    expect(p.menu()).toBe(true);
    p.track(true);
    expect(p.menu()).toBe(true);
    expect(p.menu({ shiftKey: true })).toBe(true);
    expect(p.pastes()).toBe(2);
    p.free();
    const n = await setup('none');
    expect(n.menu()).toBe(true);
    expect(n.menu({ keyboard: true })).toBe(true);
    expect(n.calls).toEqual([]);
    expect(n.pastes()).toBe(0);
    n.free();
  });

  test('with no selection manager the menu still routes', () => {
    const t = mouse({ rightClickBehavior: 'copyPaste' });
    let cancelled = false;
    t.container.dispatch({
      type: 'contextmenu',
      button: 2,
      shiftKey: false,
      preventDefault: () => {
        cancelled = true;
      },
    } as unknown as Event);
    expect(cancelled).toBe(false);
  });
});

describe('browserTimeouts', () => {
  test("reads the page's window.setTimeout and the global clearTimeout when called", () => {
    const g = globalThis as Record<string, unknown>;
    const saved = g.window;
    const scheduled: number[] = [];
    g.window = { setTimeout: (_run: () => void, ms: number) => scheduled.push(ms) };
    try {
      expect(browserTimeouts.setTimeout(() => {}, 16)).toBe(1);
      expect(scheduled).toEqual([16]);
      browserTimeouts.clearTimeout(undefined);
    } finally {
      g.window = saved;
    }
  });
});
