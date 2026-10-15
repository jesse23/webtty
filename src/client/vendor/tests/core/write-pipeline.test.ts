import { describe, expect, test } from 'bun:test';
import { ManualClock } from '../../../test-support/manual-clock';
import type { WriteEngine, WriteHost } from '../../ghostty-web/core/host-types';
import { WritePipeline } from '../../ghostty-web/core/write-pipeline';
import type { TerminalEffects } from '../../ghostty-web/ghostty';
import { loadGhostty } from '../support/wasm';

// The write pipeline: one write's fixed order against a recording engine and host
// (ADR 061), the view kept on its text (ADR 066), the effects, the alternate screen's
// scroll to the bottom, the echo render, the write callback, the sync hold's output (ADR
// 067), the reply drain and clear screen at ground (ADR 054) on a real engine.

const NO_EFFECTS: TerminalEffects = {
  bell: false,
  title: null,
  clipboard: null,
  notifications: [],
};

interface Options {
  /** What the engine's readEffects returns once. */
  effects?: TerminalEffects;
  replies?: string[];
  viewportY?: number;
  anchored?: boolean;
  alternate?: boolean;
  disableStdin?: boolean;
  /** The engine write throws, as on a wasm trap. */
  throws?: boolean;
  /** Where SyncHold.paintPoint says to paint; -1 by default. */
  paintAt?: number;
}

/** A pipeline on a recording engine and host: `calls` logs both, in order. */
function recorded(options: Options = {}) {
  const calls: string[] = [];
  const replies = [...(options.replies ?? [])];
  let effects = options.effects ?? NO_EFFECTS;
  const engine: WriteEngine = {
    write: (data) => {
      if (options.throws) throw new Error('parse');
      calls.push(`engine.write ${JSON.stringify(typeof data === 'string' ? data : [...data])}`);
    },
    writeUntilGround: () => null,
    isAlternateScreen: () => options.alternate ?? false,
    cursorAtPrompt: () => false,
    getCursor: () => ({
      x: 0,
      y: 0,
      viewportX: 0,
      viewportY: 0,
      visible: true,
      style: 'block',
      blinking: false,
    }),
    readResponse: () => {
      const reply = replies.shift() ?? null;
      if (reply !== null) calls.push(`reply ${reply}`);
      return reply;
    },
    readEffects: () => {
      calls.push('readEffects');
      const once = effects;
      effects = NO_EFFECTS;
      return once;
    },
  };
  const host = recordingHost(calls, () => engine, options);
  const clock = new ManualClock();
  return { calls, clock, pipeline: new WritePipeline(host, clock) };
}

/** A host that logs every call into `calls`. */
function recordingHost(
  calls: string[],
  engine: () => WriteEngine | undefined,
  options: Options,
): WriteHost {
  return {
    engine,
    disableStdin: () => options.disableStdin ?? false,
    send: (data) => calls.push(`send ${JSON.stringify(data)}`),
    followFocusMode: () => calls.push('followFocusMode'),
    bell: () => calls.push('bell'),
    title: (title) => calls.push(`title ${title}`),
    clipboardWrite: (text) => calls.push(`clipboard ${text}`),
    notify: (n) => calls.push(`notify ${n.title}/${n.body}`),
    outputChanged: () => calls.push('outputChanged'),
    findAnchored: () => options.anchored ?? false,
    scrollToBottom: () => calls.push('scrollToBottom'),
    pinView: () => {
      calls.push('pinView');
      return (options.viewportY ?? 0) > 0;
    },
    unpinView: () => calls.push('unpinView'),
    syncPaintPoint: () => options.paintAt ?? -1,
    paintUpdate: () => calls.push('paintUpdate'),
    wroteOutput: (data) => calls.push(`wroteOutput ${JSON.stringify(data)}`),
    renderEcho: () => calls.push('renderEcho'),
  };
}

describe('WritePipeline order', () => {
  test('view pinned, write, sync timing, replies, focus edge, effects, link cache, callback, echo', () => {
    const { calls, clock, pipeline } = recorded({
      effects: {
        bell: true,
        title: 'vim',
        clipboard: 'copied',
        notifications: [
          { title: 'a', body: '1' },
          { title: 'b', body: '2' },
        ],
      },
      replies: ['\x1b[1;1R', '\x1b[0n'],
      viewportY: 5,
    });
    let called = 0;
    pipeline.awaitEcho();
    pipeline.write('x', () => called++);
    expect(calls).toEqual([
      'pinView',
      'engine.write "x"',
      'unpinView',
      'wroteOutput "x"',
      'reply \x1b[1;1R',
      'send "\\u001b[1;1R"',
      'reply \x1b[0n',
      'send "\\u001b[0n"',
      'followFocusMode',
      'readEffects',
      'bell',
      'title vim',
      'clipboard copied',
      'notify a/1',
      'notify b/2',
      'outputChanged',
      'renderEcho',
    ]);
    // The callback waits for the next frame
    expect(called).toBe(0);
    clock.frame();
    expect(called).toBe(1);
  });

  test('without effects, at the bottom and with no input sent, only the fixed steps run', () => {
    const { calls, clock, pipeline } = recorded();
    pipeline.write('x');
    expect(calls).toEqual([
      'pinView',
      'engine.write "x"',
      'wroteOutput "x"',
      'followFocusMode',
      'readEffects',
      'outputChanged',
    ]);
    expect(clock.pending.frames).toBe(0);
  });

  test('the echo render runs once, for the first write after input', () => {
    const { calls, pipeline } = recorded();
    pipeline.awaitEcho();
    pipeline.write('a');
    pipeline.write('b');
    expect(calls.filter((c) => c === 'renderEcho')).toHaveLength(1);
  });

  test.each([
    // [anchored on a find match, alternate screen, what the view does]
    [false, false, ['pinView', 'unpinView']],
    [true, false, []],
    [false, true, ['scrollToBottom']],
    [true, true, ['scrollToBottom']],
  ])('a scrolled view, anchored %p, alternate %p: %p', (anchored, alternate, moves) => {
    const { calls, pipeline } = recorded({ viewportY: 3, anchored, alternate });
    pipeline.write('x');
    expect(calls.filter((c) => /^(pinView|unpinView|scrollToBottom)$/.test(c))).toEqual(moves);
  });

  test('a write that throws still unpins the view', () => {
    const { calls, pipeline } = recorded({ viewportY: 3, throws: true });
    expect(() => pipeline.write('x')).toThrow('parse');
    expect(calls).toEqual(['pinView', 'unpinView']);
  });

  test('the sync hold sees all the output, the part a waiting clear came after too (ADR 067)', async () => {
    const term = (await loadGhostty()).createTerminal(20, 5);
    const calls: string[] = [];
    const pipeline = new WritePipeline(recordingHost(calls, () => term, {}));
    pipeline.write('\x1b[3');
    pipeline.clearAtGround();
    pipeline.write('C\x1b[?2026h');
    expect(calls.filter((c) => c.startsWith('wroteOutput')).at(-1)).toBe(
      'wroteOutput "C\\u001b[?2026h"',
    );
    term.free();
  });

  test('an update a held frame waits for is painted at its end, before the rest is written (ADR 067)', () => {
    const writes = (c: string[]) => c.filter((x) => /^(engine\.write|paintUpdate)/.test(x));
    const { calls, pipeline } = recorded({ paintAt: 3 });
    pipeline.write('endnext');
    expect(writes(calls)).toEqual(['engine.write "end"', 'paintUpdate', 'engine.write "next"']);
    const atEnd = recorded({ paintAt: 3 });
    atEnd.pipeline.write(new TextEncoder().encode('end'));
    expect(writes(atEnd.calls)).toEqual(['engine.write [101,110,100]', 'paintUpdate']);
    // A pinned write keeps Ghostty's viewport off the view: it paints on a frame
    const pinned = recorded({ paintAt: 3, viewportY: 2 });
    pinned.pipeline.write('endnext');
    expect(writes(pinned.calls)).toEqual(['engine.write "endnext"']);
  });

  test('drainReplies sends every queued reply, and nothing without an engine', () => {
    const { calls, pipeline } = recorded({ replies: ['a', 'b'] });
    pipeline.drainReplies();
    expect(calls).toEqual(['reply a', 'send "a"', 'reply b', 'send "b"']);
    const none: string[] = [];
    new WritePipeline(recordingHost(none, () => undefined, {})).drainReplies();
    expect(none).toEqual([]);
  });
});

describe('WritePipeline dispose', () => {
  test('cancels the callbacks still waiting, and forgets the ones run; again does nothing (ADR 065)', () => {
    const { clock, pipeline } = recorded();
    const called: string[] = [];
    pipeline.write('a', () => called.push('a'));
    clock.frame();
    pipeline.write('b', () => called.push('b'));
    pipeline.write('c', () => called.push('c'));
    expect(clock.pending.frames).toBe(2);
    pipeline.dispose();
    pipeline.dispose();
    clock.frame();
    expect([called, clock.pending.frames]).toEqual([['a'], 0]);
  });
});

describe('WritePipeline clear at ground', () => {
  // Ghostty's clear_screen written to the terminal (ADR 054), on a real 20x5 engine.
  async function engine() {
    const ghostty = await loadGhostty();
    const term = ghostty.createTerminal(20, 5);
    const calls: string[] = [];
    const pipeline = new WritePipeline(recordingHost(calls, () => term, {}));
    const sent = () => calls.filter((c) => c.startsWith('send'));
    return { term, pipeline, sent };
  }

  test('waits for a sequence cut off by a write, then clears where it ends', async () => {
    const { term, pipeline, sent } = await engine();
    for (let i = 0; i < 8; i++) pipeline.write(`line${i}\r\n`);
    pipeline.write('\x1b[3');
    pipeline.clearAtGround();
    expect(term.getScrollbackLength()).toBeGreaterThan(0);
    // The sequence ends (CUF 3): the clear goes in after it
    pipeline.write('Cafter');
    expect(term.getScrollbackLength()).toBe(0);
    expect(sent()).toEqual([]);
    term.free();
  });

  test('at an OSC 133 prompt, erases everything and sends FF', async () => {
    const { term, pipeline, sent } = await engine();
    pipeline.write('old\r\n\x1b]133;A\x07$ ');
    pipeline.clearAtGround();
    expect(sent()).toEqual(['send "\\f"']);
    term.free();
  });

  test('reset drops a waiting clear', async () => {
    const { term, pipeline } = await engine();
    for (let i = 0; i < 8; i++) pipeline.write(`line${i}\r\n`);
    pipeline.write('\x1b[3');
    pipeline.clearAtGround();
    pipeline.reset();
    pipeline.write('C');
    expect(term.getScrollbackLength()).toBeGreaterThan(0);
    term.free();
  });

  test('a waiting clear is dropped if the screen has turned alternate', async () => {
    const { term, pipeline } = await engine();
    for (let i = 0; i < 8; i++) pipeline.write(`line${i}\r\n`);
    const scrollback = term.getScrollbackLength();
    pipeline.write('\x1b[?1049');
    pipeline.clearAtGround();
    pipeline.write('h');
    expect(term.isAlternateScreen()).toBe(true);
    pipeline.write('\x1b[?1049l');
    expect(term.getScrollbackLength()).toBe(scrollback);
    term.free();
  });
});
