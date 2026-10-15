import { afterEach, describe, expect, test } from 'bun:test';
import { type FakeContext, fakeContext } from '../../test-support/fake-context';
import { AT_ONCE, type Pace } from '../../vendor/ghostty-web';
import { installScroll, type ScrollDeps } from './scroll-feature';

let fake: FakeContext;

afterEach(async () => {
  await fake.dom.close();
});

/** A SmoothScroll and WheelStream stand-in that log what the hooks ask of them. */
function scrollParts(takes = true) {
  const log: string[] = [];
  const pace: Pace = AT_ONCE;
  const smoothScroll: ScrollDeps['smoothScroll'] = {
    handleWheel: () => {
      log.push('handleWheel');
      return takes;
    },
    frame: (now) => {
      log.push(`frame@${now}`);
    },
  };
  const wheelStream: ScrollDeps['wheelStream'] = {
    forApp: () => {
      log.push('forApp');
      return pace;
    },
  };
  return { log, pace, smoothScroll, wheelStream };
}

const wheel = { deltaY: -10 } as WheelEvent;

describe('installScroll', () => {
  test('the wheel handler scrolls the scrollback unless the app tracks the mouse', () => {
    fake = fakeContext();
    const parts = scrollParts();
    installScroll(fake.ctx, parts);
    expect(fake.term.wheelHandler?.(wheel)).toBe(true);
    fake.term.mouseTracking = true;
    expect(fake.term.wheelHandler?.(wheel)).toBe(false);
    expect(parts.log).toEqual(['handleWheel']);
  });

  test('the handler leaves to ghostty-web what SmoothScroll does not take', () => {
    fake = fakeContext();
    const parts = scrollParts(false);
    installScroll(fake.ctx, parts);
    expect(fake.term.wheelHandler?.(wheel)).toBe(false);
  });

  test('the app wheel is paced by the stream, and each render advances the glide first', () => {
    fake = fakeContext();
    const parts = scrollParts();
    installScroll(fake.ctx, parts);
    expect(fake.term.wheelPace?.(wheel)).toBe(parts.pace);
    fake.term.beforeRender?.(42);
    expect(parts.log).toEqual(['forApp', 'frame@42']);
  });

  test('dispose detaches the three hooks; twice is a no-op', () => {
    fake = fakeContext();
    const feature = installScroll(fake.ctx, scrollParts());
    feature.dispose();
    feature.dispose();
    expect([fake.term.wheelHandler, fake.term.wheelPace, fake.term.beforeRender]).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });
});
