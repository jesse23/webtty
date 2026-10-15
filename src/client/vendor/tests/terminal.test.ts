import { afterEach, describe, expect, test } from 'bun:test';
import type { ITerminalAddon } from '../ghostty-web/interfaces';
import { Terminal } from '../ghostty-web/terminal';
import {
  engineOf,
  openTerminal,
  rendererOf,
  screenText,
  scrollbackLines,
  stubGlobals,
  type TerminalHarness,
} from './support/terminal-harness';
import { markedSession } from './support/terminal-text';

// The Terminal facade through its public API, opened on fakes over the real engine. Its
// collaborators have their own tests in core/ (ADR 061).

let h: TerminalHarness | undefined;

/** Opens the terminal this test uses; afterEach closes it. */
async function open(options: Parameters<typeof openTerminal>[0] = {}): Promise<TerminalHarness> {
  h = await openTerminal(options);
  return h;
}

afterEach(() => {
  h?.close();
  h = undefined;
});

/** A printable key as the browser delivers it to the container. */
function keydown(key: string) {
  return {
    type: 'keydown',
    key,
    code: `Key${key.toUpperCase()}`,
    keyCode: key.toUpperCase().charCodeAt(0),
    isComposing: false,
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    preventDefault: () => {},
  };
}

describe('Terminal options', () => {
  test('fills every option it is not given with its default', () => {
    const term = new Terminal({ ghostty: {} as never, fontSize: 20 });
    expect([term.options.fontSize, term.options.fontFamily, term.cols, term.rows]).toEqual([
      20,
      'monospace',
      80,
      24,
    ]);
    expect(term.options.rightClickBehavior).toBe('contextMenu');
  });

  test('a change before open() is kept and applied by nothing', () => {
    const term = new Terminal({ ghostty: {} as never });
    term.options.cursorStyle = 'bar';
    term.options.cols = 100;
    expect([term.options.cursorStyle, term.cols]).toEqual(['bar', 80]);
  });

  test('a cursor option change after open() sets the engine default', async () => {
    // The configured shape is the engine's default, which DECSCUSR 0 and RIS restore (ADR 049)
    const { term } = await open();
    const defaults: unknown[] = [];
    engineOf(term).setDefaultCursor = (style, blink) => void defaults.push([style, blink]);
    term.options.cursorStyle = 'underline';
    term.options.cursorBlink = true;
    term.options.cursorBlink = true;
    expect(defaults).toEqual([
      ['underline', false],
      ['underline', true],
    ]);
  });

  test('a size change after open() resizes, a font change re-sizes the canvas element', async () => {
    const { term, canvas } = await open();
    const width = rendererOf(term).getMetrics().width;
    term.options.cols = 30;
    expect([term.cols, canvas.style.width]).toEqual([30, `${width * 30}px`]);
    canvas.style.width = '';
    term.options.fontFamily = 'serif';
    expect(canvas.style.width).toBe(`${width * 30}px`);
    canvas.style.width = '';
    term.options.fontSize = 20;
    expect(canvas.style.width).toBe(`${rendererOf(term).getMetrics().width * 30}px`);
  });
});

describe('Terminal lifecycle', () => {
  test('open() builds the DOM and its parts; dispose() takes them down', async () => {
    const { term, container } = await open();
    // The terminal's canvas, the renderer's drawing canvas (ADR 043), the input textarea
    expect(container.children.map((c) => c.tagName)).toEqual(['canvas', 'canvas', 'textarea']);
    expect(container.hasAttribute('role')).toBe(true);
    expect([term.element, term.textarea, term.wasmTerm, term.renderer].every(Boolean)).toBe(true);
    term.dispose();
    expect(container.children).toEqual([]);
    expect(container.hasAttribute('role')).toBe(false);
    // The tabindex stays, as it always has
    expect(container.hasAttribute('tabindex')).toBe(true);
    expect([term.element, term.textarea, term.wasmTerm, term.renderer]).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  test('opening twice, or after dispose, throws; so does use before open', async () => {
    const { term, container } = await open();
    const parent = container as unknown as HTMLElement;
    expect(() => term.open(parent)).toThrow('already open');
    term.dispose();
    expect(() => term.open(parent)).toThrow('disposed');
    expect(() => term.write('x')).toThrow('disposed');
    const closed = new Terminal({ ghostty: {} as never });
    expect(() => closed.write('x')).toThrow('must be opened');
    expect(() => closed.getMode(1)).toThrow('must be opened');
    expect(() => closed.scrollLines(1)).toThrow('Terminal not open');
  });

  test('a failed open() takes down what it made and throws', () => {
    const globals = stubGlobals();
    try {
      const container = globals.element();
      const term = new Terminal({
        ghostty: {
          createTerminal: () => {
            throw new Error('no engine');
          },
        } as never,
      });
      expect(() => term.open(container as unknown as HTMLElement)).toThrow(
        'Failed to open terminal: Error: no engine',
      );
      expect(container.children).toEqual([]);
      expect(container.hasAttribute('role')).toBe(false);
      expect(term.element).toBeUndefined();
      term.dispose();
    } finally {
      globals.restore();
    }
  });

  test('addons are activated on load and disposed with the terminal, once', async () => {
    const { term } = await open();
    const calls: string[] = [];
    const addon: ITerminalAddon = {
      activate: (t) => void calls.push(t === term ? 'activate' : 'other'),
      dispose: () => void calls.push('dispose'),
    };
    term.loadAddon(addon);
    term.dispose();
    term.dispose();
    expect(calls).toEqual(['activate', 'dispose']);
  });

  test('focus() focuses the container now and again after a tick', async () => {
    const { term, container, doc, clock } = await open();
    const focused = () => doc.activeElement;
    doc.activeElement = null;
    term.focus();
    expect(focused()).toBe(container);
    doc.activeElement = null;
    clock.advance(0);
    expect(focused()).toBe(container);
  });

  test('dispose() cancels a refocus still waiting (ADR 065)', async () => {
    const { term, doc, clock } = await open();
    term.focus();
    term.dispose();
    doc.activeElement = null;
    clock.advance(0);
    expect(doc.activeElement).toBeNull();
  });

  test('before open() the read-only API answers empty', () => {
    const term = new Terminal({ ghostty: {} as never });
    expect(term.getScrollbackLength()).toBe(0);
    expect(term.getScrollbackLine(0)).toBeNull();
    expect(term.getScrollbackGraphemeString(0, 0)).toBe(' ');
    expect(term.getCursorCellOffset()).toBeUndefined();
    expect(term.getSelection()).toBe('');
    expect(term.copySelection()).toBe(false);
    term.syncCellPixelSize();
    term.jumpToPrompt(-1);
    term.focus();
  });
});

describe('Terminal write, resize and reset', () => {
  test('write() converts LF to CRLF with convertEol and runs its callback after a frame', async () => {
    const { term, clock } = await open({ convertEol: true });
    let called = 0;
    term.write('a\nb', () => called++);
    expect(screenText(term).slice(0, 2)).toEqual(['a', 'b']);
    expect(called).toBe(0);
    clock.frame();
    expect(called).toBe(1);
  });

  test('resize() fires onResize and sizes the canvas; the same size does nothing', async () => {
    const { term, canvas } = await open();
    const sizes: unknown[] = [];
    term.onResize((size) => sizes.push(size));
    term.resize(20, 5);
    term.resize(30, 8);
    expect(sizes).toEqual([{ cols: 30, rows: 8 }]);
    expect(engineOf(term).getDimensions()).toEqual({ cols: 30, rows: 8 });
    expect(canvas.style.width).toBe(`${rendererOf(term).getMetrics().width * 30}px`);
  });

  test('a resize sends the size report the app asked for (mode 2048)', async () => {
    const { term, sent } = await open();
    term.write('\x1b[?2048h');
    sent.length = 0;
    term.resize(30, 8);
    expect(sent.join('')).toContain('\x1b[48;8;30;');
  });

  test('reset() starts a new engine and reports the same title again', async () => {
    const { term } = await open();
    const titles: string[] = [];
    term.onTitleChange((t) => titles.push(t));
    term.write('hello\x1b]2;vim\x07\x1b]2;vim\x07');
    const before = term.wasmTerm;
    term.reset();
    expect(term.wasmTerm).not.toBe(before);
    expect(screenText(term)[0]).toBe('');
    term.write('\x1b]2;vim\x07');
    expect(titles).toEqual(['vim', 'vim']);
  });

  test('getMode and hasMouseTracking read the engine', async () => {
    const { term } = await open();
    term.write('\x1b[?2004h\x1b[?1000h');
    expect([term.getMode(2004), term.getMode(4, true), term.hasMouseTracking()]).toEqual([
      true,
      false,
      true,
    ]);
  });

  test('the cursor cell offset follows the cursor and the view', async () => {
    const { term } = await open();
    const { width, height } = rendererOf(term).getMetrics();
    term.write('abc\r\nde');
    expect(term.getCursorCellOffset()).toEqual({ left: 2 * width, top: height });
  });

  test('syncCellPixelSize sends a size report when only the pixels change', async () => {
    const { term, sent } = await open();
    term.write('\x1b[?2048h');
    sent.length = 0;
    term.syncCellPixelSize();
    // The same pixels: Ghostty makes no update
    expect(sent).toEqual([]);
  });
});

describe('Terminal paste', () => {
  // Pastes are encoded by ghostty_terminal_paste and leave through onData (ADR 049).
  test('sends the text as Ghostty encodes it for the mode', async () => {
    const { term, sent } = await open();
    sent.length = 0;
    term.paste('one\ntwo\x1b');
    term.write('\x1b[?2004h');
    term.paste('three');
    expect(sent).toEqual(['one\rtwo ', '\x1b[200~three\x1b[201~']);
  });

  test('sends nothing with stdin disabled', async () => {
    const { term, sent } = await open({ disableStdin: true });
    term.paste('hello');
    expect(sent).toEqual([]);
    expect(engineOf(term).hasResponse()).toBe(false);
  });
});

describe('Terminal clearScreen', () => {
  // Ghostty's clear_screen with what libghostty-vt has: the erasing is written to the
  // terminal, and only FF, at a prompt, goes to the app (ADR 054).
  const fill = (term: Terminal) => {
    for (let i = 0; i < 8; i++) term.write(`line${i}\r\n`);
  };

  test('away from a prompt, drops the scrollback and the rows above the cursor', async () => {
    const { term, sent } = await open();
    fill(term);
    term.write('$ make');
    expect(term.clearScreen()).toBe(true);
    expect(screenText(term)).toEqual(['$ make', '', '', '', '']);
    expect(scrollbackLines(term)).toEqual([]);
    expect(engineOf(term).getCursor()).toMatchObject({ x: 6, y: 0 });
    // Output in progress carries on below the cursor's row
    term.write('\r\nok');
    expect(screenText(term)).toEqual(['$ make', 'ok', '', '', '']);
    expect(sent).toEqual([]);
  });

  test('with the cursor on the top row, drops only the scrollback', async () => {
    const { term } = await open();
    fill(term);
    term.write('\x1b[H');
    expect(term.clearScreen()).toBe(true);
    expect(screenText(term)).toEqual(['line4', 'line5', 'line6', 'line7', '']);
    expect(scrollbackLines(term)).toEqual([]);
  });

  test('at an OSC 133 prompt, erases everything and sends FF for the shell to redraw', async () => {
    const { term, sent } = await open();
    fill(term);
    term.write('\x1b]133;A\x07~ > \x1b]133;B\x07ls');
    expect(engineOf(term).cursorAtPrompt()).toBe(true);
    expect(term.clearScreen()).toBe(true);
    expect(screenText(term)).toEqual(['', '', '', '', '']);
    expect(scrollbackLines(term)).toEqual([]);
    expect(sent).toEqual(['\x0c']);
  });

  test('sends no FF with stdin disabled', async () => {
    const { term, sent } = await open({ disableStdin: true });
    term.write('\x1b]133;A\x07$ \x1b]133;B\x07');
    expect(term.clearScreen()).toBe(true);
    expect(sent).toEqual([]);
  });

  test('does nothing on the alternate screen, where the key goes to the app', async () => {
    const { term, sent } = await open();
    fill(term);
    term.write('\x1b[?1049h\x1b[Hvim');
    expect(term.clearScreen()).toBe(false);
    expect(screenText(term)[0]).toBe('vim');
    term.write('\x1b[?1049l');
    expect(term.getScrollbackLength()).toBe(4);
    expect(sent).toEqual([]);
  });

  test('clears the selection', async () => {
    const { term } = await open();
    fill(term);
    let cleared = 0;
    term.clearSelection = () => void cleared++;
    term.clearScreen();
    expect(cleared).toBe(1);
  });

  test('waits for a sequence cut off by the end of a write, and clears where it ends', async () => {
    const { term } = await open();
    fill(term);
    term.write('build \x1b[3');
    expect(term.clearScreen()).toBe(true);
    expect(scrollbackLines(term).length).toBeGreaterThan(0);
    // The rest of the SGR finishes it; the clear goes in there, before the text after it
    term.write('1mred\r\nnext');
    expect(screenText(term)).toEqual(['build red', 'next', '', '', '']);
    expect(scrollbackLines(term)).toEqual([]);
    const red = engineOf(term).getLine(0)?.[6];
    expect(red && red.fg_r > red.fg_g).toBe(true);
  });

  test('a cut-off OSC keeps its effect', async () => {
    const { term } = await open();
    fill(term);
    const titles: string[] = [];
    term.onTitleChange((t) => titles.push(t));
    term.write('\x1b]2;bui');
    term.clearScreen();
    term.write('ld\x07');
    expect(titles).toEqual(['build']);
    expect(scrollbackLines(term)).toEqual([]);
  });

  test('a write that ends inside another sequence still gets the clear', async () => {
    const { term } = await open();
    fill(term);
    term.write('a\x1b[3');
    term.clearScreen();
    term.write('1mb\x1b[0');
    expect(scrollbackLines(term)).toEqual([]);
    term.write('mc');
    expect(screenText(term)).toEqual(['abc', '', '', '', '']);
  });

  test('a waiting clear at a prompt checks the prompt and sends FF once it goes in', async () => {
    const { term, sent } = await open();
    fill(term);
    term.write('\x1b]133;A\x07$ \x1b]133;B\x07\x1b[3');
    term.clearScreen();
    expect(sent).toEqual([]);
    term.write('1m');
    expect(screenText(term)).toEqual(['', '', '', '', '']);
    expect(sent).toEqual(['\x0c']);
  });

  test('a waiting clear is dropped if the screen has turned alternate', async () => {
    const { term } = await open();
    fill(term);
    term.write('\x1b[?1049');
    term.clearScreen();
    term.write('h\x1b[Hvim');
    term.write('\x1b[?1049l');
    expect(scrollbackLines(term).length).toBeGreaterThan(0);
  });
});

describe('Terminal find', () => {
  // Find with libghostty-vt's search, run in the render loop (ADR 055).
  async function findTerm() {
    const harness = await open({ rows: 4, scrollbackLines: 1000 });
    const { term, clock } = harness;
    const highlights: unknown[] = [];
    const renderer = rendererOf(term);
    const setSearchHighlights = renderer.setSearchHighlights.bind(renderer);
    renderer.setSearchHighlights = (hl) => {
      highlights.push(hl);
      setSearchHighlights(hl);
    };
    const states: unknown[] = [];
    term.onFindChange((s) => states.push(s));
    /** Render-loop frames, a second apart: the search steps before each render. */
    const frames = (n = 1) => {
      for (let i = 0; i < n; i++) clock.frame(1000);
    };
    return { ...harness, frames, states, last: () => highlights[highlights.length - 1] };
  }

  const needleAbove = (term: Terminal) => {
    term.write('needle\r\n');
    for (let i = 0; i < 20; i++) term.write(`line ${i}\r\n`);
  };

  test('output keeps a scrolled view on its rows while a match is selected', async () => {
    const { term, frames } = await findTerm();
    needleAbove(term);
    term.find('needle');
    frames(2);
    expect(term.finding).toBe(true);
    expect(term.findNext()).toBe(true);
    const view = term.viewportY;
    expect(view).toBeGreaterThan(0);
    term.write('more\r\nmore\r\nmore\r\n');
    expect(term.viewportY).toBe(view);
    frames();
    expect(term.viewportY).toBe(view + 3);
    // The view still starts at the match
    expect(term.getScrollbackLength() - term.viewportY).toBe(0);
    expect(term.findPrevious()).toBe(true);
  });

  test('without a selected match, output scrolls to the bottom as before', async () => {
    const { term, frames } = await findTerm();
    for (let i = 0; i < 20; i++) term.write(`line ${i}\r\n`);
    term.find('line');
    frames(2);
    term.scrollToLine(5);
    term.write('x\r\n');
    expect(term.viewportY).toBe(0);
  });

  test('a key or a paste scrolls a view on a selected match to the bottom', async () => {
    // Ghostty's `scroll-to-bottom = keystroke` (ADR 055)
    const { term, frames, container } = await findTerm();
    needleAbove(term);
    term.find('needle');
    frames(2);
    term.findNext();
    expect(term.viewportY).toBeGreaterThan(0);
    container.dispatch(keydown('l'));
    expect(term.viewportY).toBe(0);
    // and the echo is followed
    term.write('l\r\n');
    frames();
    expect(term.viewportY).toBe(0);
    term.findNext();
    expect(term.viewportY).toBeGreaterThan(0);
    term.paste('ls');
    expect(term.viewportY).toBe(0);
  });

  test('output that switches to the alternate screen scrolls to the bottom', async () => {
    const { term, frames } = await findTerm();
    needleAbove(term);
    term.find('needle');
    frames(2);
    term.findNext();
    expect(term.viewportY).toBeGreaterThan(0);
    term.write('\x1b[?1049hpager');
    expect(term.viewportY).toBe(0);
    frames();
    expect(term.viewportY).toBe(0);
  });

  test('ending the search clears the highlights and the count', async () => {
    const { term, frames, states, last } = await findTerm();
    term.write('abc abc');
    term.find('abc');
    frames();
    term.findNext();
    frames();
    term.endFind();
    expect(term.finding).toBe(false);
    expect(last()).toBeNull();
    expect(states[states.length - 1]).toEqual({ total: 0, selected: null });
    frames();
    expect(last()).toBeNull();
    expect(term.findNext()).toBe(false);
  });

  test('a reset (reconnect) searches the new engine', async () => {
    const { term, frames, states } = await findTerm();
    term.write('abc');
    term.find('abc');
    frames();
    expect(states[states.length - 1]).toEqual({ total: 1, selected: null });
    term.reset();
    frames();
    expect(states[states.length - 1]).toEqual({ total: 0, selected: null });
    term.write('abc abc');
    frames();
    expect(states[states.length - 1]).toEqual({ total: 2, selected: null });
  });
});

describe('Terminal output effects', () => {
  // Bell, title, clipboard writes and notifications come from the engine's readEffects,
  // not from scanning the output (ADR 047, ADR 052, ADR 056).
  test('a bell and a new title reach onBell and onTitleChange, a repeated title does not', async () => {
    const { term } = await open();
    let bells = 0;
    const titles: string[] = [];
    term.onBell(() => bells++);
    term.onTitleChange((title) => titles.push(title));
    term.write('\x1b]2;vim\x07\x07');
    term.write('\x1b]2;vim\x07');
    expect([bells, titles]).toEqual([1, ['vim']]);
  });

  test('OSC 52 output fires onClipboardWrite with the decoded text, once', async () => {
    const { term } = await open();
    const copied: string[] = [];
    term.onClipboardWrite((text) => copied.push(text));
    term.write(`\x1b]52;c;${Buffer.from('héllo 中文').toString('base64')}\x07`);
    expect(copied).toEqual(['héllo 中文']);
    term.write('plain output');
    term.write('\x1b]52;c;\x07');
    expect(copied).toEqual(['héllo 中文', '']);
  });

  test('OSC 9 and OSC 777 output fire onDesktopNotification, each once, in order', async () => {
    const { term } = await open();
    const shown: { title: string; body: string }[] = [];
    term.onDesktopNotification((n) => shown.push(n));
    term.write('\x1b]9;Build done\x07\x1b]777;notify;Claude Code;Needs your input\x1b\\');
    expect(shown).toEqual([
      { title: '', body: 'Build done' },
      { title: 'Claude Code', body: 'Needs your input' },
    ]);
    term.write('plain output');
    expect(shown).toHaveLength(2);
  });

  test('reports when a write sets mode 1004, and on resyncFocus, the focus it has', async () => {
    // The focus tracker's own tests are in core/focus-tracker.test.ts (ADR 053)
    const { term, sent, doc } = await open();
    doc.activeElement = null;
    sent.length = 0;
    term.resyncFocus();
    expect(sent).toEqual([]);
    term.write('\x1b[?1004h');
    term.resyncFocus();
    expect(sent).toEqual(['\x1b[O', '\x1b[O']);
  });
});

describe('Terminal input', () => {
  // The input route's own tests are in core/terminal-controllers.test.ts (ADR 051).
  test('a key goes to onData and scrolls to the bottom', async () => {
    const { term, sent, container } = await open();
    term.write('x\r\n'.repeat(10));
    term.scrollToLine(3);
    container.dispatch(keydown('a'));
    expect(sent).toContain('a');
    expect(term.viewportY).toBe(0);
  });
});

describe('Terminal scrolling', () => {
  test('scrollLines, scrollToLine and scrollToBottom move the view and fire onScroll', async () => {
    const { term } = await open();
    term.write('x\r\n'.repeat(10));
    const scrolls: number[] = [];
    term.onScroll((y) => scrolls.push(y));
    term.scrollLines(-2);
    term.scrollToLine(100);
    term.scrollToBottom();
    expect(scrolls).toEqual([2, term.getScrollbackLength(), 0]);
    expect(term.getViewportY()).toBe(0);
  });

  test('jumpToPrompt scrolls a prompt to the top row, up and down, and back to the bottom', async () => {
    // Ghostty's jump_to_prompt on libghostty-vt's DELTA_PROMPT (ADR 057)
    const { term } = await open();
    // Prompts on rows 0, 7 and 14; 17 rows of scrollback
    term.write(markedSession());
    const scrolls: number[] = [];
    term.onScroll((y) => scrolls.push(y));
    term.jumpToPrompt(-1);
    expect(term.viewportY).toBe(17 - 14);
    term.jumpToPrompt(-1);
    expect(term.viewportY).toBe(17 - 7);
    term.jumpToPrompt(-1);
    term.jumpToPrompt(-1);
    expect(term.viewportY).toBe(17);
    term.jumpToPrompt(1);
    expect(term.viewportY).toBe(10);
    term.jumpToPrompt(2);
    expect(term.viewportY).toBe(0);
    expect(scrolls).toEqual([3, 10, 17, 10, 0]);
  });

  test('jumpToPrompt leaves a fractional view alone when there is nowhere to go', async () => {
    const { term } = await open();
    term.write(Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\r\n'));
    term.viewportY = 2.5;
    term.jumpToPrompt(-1);
    term.jumpToPrompt(1);
    expect(term.viewportY).toBe(2.5);
  });

  test('a scroll shows the scrollbar: later frames paint it, then it fades away', async () => {
    const { term, clock } = await open();
    term.write('x\r\n'.repeat(10));
    const opacities: number[] = [];
    const renderer = rendererOf(term);
    const render = renderer.render.bind(renderer);
    renderer.render = (...args) => {
      opacities.push(args[4] ?? 1);
      render(...args);
    };
    term.scrollLines(-1);
    expect(opacities.length).toBeGreaterThan(0);
    clock.advance(5000);
    for (let i = 0; i < 30; i++) clock.frame(50);
    expect(opacities[opacities.length - 1]).toBe(0);
  });

  test("the embedder's wheel handler and pace, and the before-render callback, are used", async () => {
    const { term, container, clock, sent } = await open();
    const wheel = (deltaY: number) => ({
      type: 'wheel',
      deltaY,
      deltaX: 0,
      deltaMode: 1,
      ctrlKey: false,
      shiftKey: false,
      clientX: 10,
      clientY: 10,
      preventDefault: () => {},
      stopPropagation: () => {},
    });
    const handled: number[] = [];
    term.attachCustomWheelEventHandler((e) => handled.push(e.deltaY) === 1);
    const paced: number[] = [];
    term.attachWheelPace((e) => {
      paced.push(e.deltaY);
      return { duration: 0 };
    });
    // Taken by the handler
    container.dispatch(wheel(3));
    // Left to the terminal: on the alternate screen, arrow keys at the pace given
    term.write('\x1b[?1049h');
    container.dispatch(wheel(-2));
    expect([handled, paced]).toEqual([[3, -2], [-2]]);
    expect(sent.join('')).toBe('\x1b[A\x1b[A');
    const frames: number[] = [];
    term.attachBeforeRender((now) => frames.push(now));
    clock.frame(10);
    expect(frames.length).toBe(1);
  });

  test('the scrollback provider reads the engine', async () => {
    const { term } = await open();
    term.write('x\r\n'.repeat(10));
    expect(term.getScrollbackLine(0)?.[0].codepoint).toBe('x'.codePointAt(0));
    expect(term.getScrollbackGraphemeString(0, 0)).toBe('x');
  });
});
