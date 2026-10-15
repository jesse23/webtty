import { describe, expect, test } from 'bun:test';
import {
  type Clock,
  durationMs,
  INPUT_NAMES,
  INPUT_PROFILES,
  isInputName,
  playInput,
  signedEvents,
} from './inputs';

const { trackpad, wheel, trackpoint } = INPUT_PROFILES;

describe('input profiles', () => {
  test('the trackpad sends 2.5 px every 16 ms, 150 times', () => {
    expect(trackpad.events).toHaveLength(150);
    expect(trackpad.events.every((e) => e.gapMs === 16 && e.deltaPx === 2.5)).toBe(true);
  });

  test('the mouse wheel sends 12-16 whole-pixel notches 100-120 ms apart', () => {
    expect(wheel.events.length).toBeGreaterThanOrEqual(12);
    expect(wheel.events.length).toBeLessThanOrEqual(16);
    for (const e of wheel.events) {
      expect(e.deltaPx).toBe(100);
      expect(e.gapMs).toBeGreaterThanOrEqual(100);
      expect(e.gapMs).toBeLessThanOrEqual(120);
    }
  });

  test('the TrackPoint sends light 4.000244 px steps, then a hard push of fractional deltas', () => {
    const light = trackpoint.events.filter((e) => e.deltaPx === 4.000244);
    const hard = trackpoint.events.slice(light.length);
    expect(light.length).toBeGreaterThan(0);
    expect(light.every((e) => e.gapMs >= 140 && e.gapMs <= 160)).toBe(true);
    expect(hard.length).toBeGreaterThan(0);
    expect(hard.every((e) => !Number.isInteger(e.deltaPx))).toBe(true);
    expect(Math.max(...hard.map((e) => e.deltaPx))).toBeCloseTo(335, 0);
    // The first hard delta follows a pause; the rest come every 29-45 ms (ADR 045).
    expect(hard.slice(1).every((e) => e.gapMs >= 29 && e.gapMs <= 45)).toBe(true);
  });

  test('every profile is a fixed table: positive deltas and gaps, the same each read', () => {
    for (const name of INPUT_NAMES) {
      const { events } = INPUT_PROFILES[name];
      expect(events.every((e) => e.deltaPx > 0 && e.gapMs > 0)).toBe(true);
      expect(INPUT_PROFILES[name].events).toEqual(events);
    }
  });
});

describe('profile helpers', () => {
  test('isInputName knows the three profiles only', () => {
    expect(INPUT_NAMES.every(isInputName)).toBe(true);
    expect(isInputName('touch')).toBe(false);
    expect(isInputName('toString')).toBe(false);
  });

  test('signedEvents makes up negative and keeps down positive', () => {
    expect(signedEvents(wheel, 'up').every((e) => e.deltaPx === -100)).toBe(true);
    expect(signedEvents(wheel, 'down')).toEqual([...wheel.events]);
  });

  test('durationMs sums the gaps', () => {
    expect(durationMs(trackpad)).toBe(2400);
  });
});

describe('playInput', () => {
  test('sends each event when it is due, on a schedule from the start', async () => {
    let now = 0;
    const clock: Clock = {
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    };
    const sent: [number, number, number, number][] = [];
    const cdp = {
      wheel: async (x: number, y: number, deltaY: number) => {
        sent.push([now, x, y, deltaY]);
        now += 5; // a CDP round trip
      },
    };
    await playInput(cdp, wheel, 'up', { x: 10, y: 20 }, clock);
    expect(sent).toHaveLength(wheel.events.length);
    let due = 0;
    wheel.events.forEach((e, i) => {
      due += e.gapMs;
      expect(sent[i]).toEqual([due, 10, 20, -100]);
    });
  });
});
