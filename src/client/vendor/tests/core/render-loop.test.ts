import { describe, expect, test } from 'bun:test';
import { ManualClock } from '../../../test-support/manual-clock';
import type { RenderLoopHost } from '../../ghostty-web/core/host-types';
import { RenderLoop } from '../../ghostty-web/core/render-loop';

// The render loop on a manual clock: each frame's fixed order (ADR 061), the first frame
// run at once, stopping and restarting, and one frame callback reused for every frame.

/** A loop whose host logs each step; `replies` says whether replies are waiting. */
function loop(start = 100) {
  const clock = new ManualClock(start);
  const calls: string[] = [];
  const state = { live: true, replies: false };
  const host: RenderLoopHost = {
    live: () => state.live,
    beforeRender: (now) => calls.push(`beforeRender ${now}`),
    stepFind: (now) => calls.push(`stepFind ${now}`),
    render: () => calls.push('render'),
    hasReplies: () => state.replies,
    drainReplies: () => calls.push('drainReplies'),
    anchorTextarea: () => calls.push('anchorTextarea'),
  };
  const callbacks = new Set<unknown>();
  const frames = {
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      callbacks.add(callback);
      return clock.requestAnimationFrame(callback);
    },
    cancelAnimationFrame: clock.cancelAnimationFrame,
  };
  return { clock, calls, state, callbacks, renderLoop: new RenderLoop(host, frames, clock.now) };
}

describe('RenderLoop', () => {
  test('start runs a frame at once on the clock, in order, and queues the next', () => {
    const { calls, clock, renderLoop } = loop();
    renderLoop.start();
    expect(calls).toEqual(['beforeRender 100', 'stepFind 100', 'render', 'anchorTextarea']);
    expect(clock.pending.frames).toBe(1);
  });

  test('each frame passes its time, and drains replies before anchoring the textarea', () => {
    const { calls, clock, state, renderLoop } = loop(0);
    renderLoop.start();
    calls.length = 0;
    state.replies = true;
    clock.frame(16);
    expect(calls).toEqual([
      'beforeRender 16',
      'stepFind 16',
      'render',
      'drainReplies',
      'anchorTextarea',
    ]);
  });

  test('start while running does nothing', () => {
    const { calls, clock, renderLoop } = loop();
    renderLoop.start();
    renderLoop.start();
    expect(calls.filter((c) => c === 'render')).toHaveLength(1);
    expect(clock.pending.frames).toBe(1);
  });

  test('cancel stops it, twice is a no-op, and start runs it again', () => {
    const { calls, clock, renderLoop } = loop();
    renderLoop.start();
    renderLoop.cancel();
    renderLoop.cancel();
    expect(clock.pending.frames).toBe(0);
    calls.length = 0;
    clock.frame();
    expect(calls).toEqual([]);
    renderLoop.start();
    expect(calls).toContain('render');
  });

  test('stops at the first frame where the host is not live', () => {
    const { calls, clock, state, renderLoop } = loop();
    renderLoop.start();
    state.live = false;
    calls.length = 0;
    clock.frame();
    expect(calls).toEqual([]);
    expect(clock.pending.frames).toBe(0);
  });

  test('every frame requests the same callback: a frame allocates no closure', () => {
    const { clock, callbacks, renderLoop } = loop();
    renderLoop.start();
    for (let i = 0; i < 5; i++) clock.frame();
    expect(callbacks.size).toBe(1);
  });
});
