import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { type FakeContext, fakeContext } from '../../test-support/fake-context';
import { ManualClock } from '../../test-support/manual-clock';
import { recordListeners } from '../../test-support/recording-target';
import { FakeDecoder } from './graphics/test-support/graphics-harness';
import { installKitty } from './kitty-feature';

let fake: FakeContext;
let clock: ManualClock;
let frames: { devicePixelRatio: number } & Pick<
  ManualClock,
  'requestAnimationFrame' | 'cancelAnimationFrame'
>;

beforeEach(() => {
  clock = new ManualClock();
  frames = {
    devicePixelRatio: 1,
    requestAnimationFrame: clock.requestAnimationFrame,
    cancelAnimationFrame: clock.cancelAnimationFrame,
  };
});

afterEach(async () => {
  await fake.dom.close();
});

const ESC = '\x1b';

describe('installKitty', () => {
  test('lays the overlay over the container and listens for the tab coming back', () => {
    fake = fakeContext();
    const doc = recordListeners(fake.ctx.doc, 'document');
    installKitty(fake.ctx, { send: () => {}, window: frames, decoder: new FakeDecoder() });
    expect(fake.container.querySelector('canvas[data-kitty]')).not.toBeNull();
    expect(doc.active.map((r) => r.type)).toEqual(['visibilitychange']);
  });

  test('feed writes the text to the terminal and answers a query through send', () => {
    fake = fakeContext();
    const sent: string[] = [];
    const kitty = installKitty(fake.ctx, {
      send: (data) => sent.push(data),
      window: frames,
      decoder: new FakeDecoder(),
    });
    kitty.feed(`a${ESC}_Ga=q,i=31,s=1,v=1,f=24;AAAA${ESC}\\b`);
    expect(fake.term.output).toBe('ab');
    expect(sent).toEqual([`${ESC}_Gi=31;OK${ESC}\\`]);
    kitty.reset();
    kitty.clear();
  });

  test('the browser decoder is the default', () => {
    fake = fakeContext();
    const kitty = installKitty(fake.ctx, { send: () => {}, window: frames });
    kitty.feed('x');
    expect(fake.term.output).toBe('x');
  });

  test('dispose removes the overlay, its listener and its frame; twice is a no-op', () => {
    fake = fakeContext();
    const doc = recordListeners(fake.ctx.doc, 'document');
    const kitty = installKitty(fake.ctx, { send: () => {}, window: frames });
    expect(clock.pending.frames).toBe(1);
    kitty.dispose();
    kitty.dispose();
    expect(fake.container.querySelector('canvas[data-kitty]')).toBeNull();
    expect(doc.active).toEqual([]);
    expect(clock.pending.frames).toBe(0);
  });
});
