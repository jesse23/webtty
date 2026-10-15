// The scroll input profiles as data, and playing one through CDP mouse wheel events.
// Each profile is a fixed table, so every run sends the same events at the same times:
// a trackpad's per-frame pixel deltas, a mouse wheel's notches and a TrackPoint's sparse
// fractional deltas, as ADR 045 measured them in Chrome on macOS (constants + service).

import type { Cdp } from './cdp';

/** One wheel event: its pixel distance (positive scrolls down) and the wait before it. */
export interface WheelEvent {
  gapMs: number;
  deltaPx: number;
}

/** The input devices the benchmark imitates. */
export type InputName = 'trackpad' | 'wheel' | 'trackpoint';

/** Which way to scroll: up into the scrollback or the file's start, or down. */
export type Direction = 'up' | 'down';

/** A device's wheel events and what they stand for. */
export interface InputProfile {
  name: InputName;
  description: string;
  events: readonly WheelEvent[];
}

const repeat = (count: number, gapMs: number, deltaPx: number): WheelEvent[] =>
  Array.from({ length: count }, () => ({ gapMs, deltaPx }));

/** Gaps between a mouse wheel's notches, spun by hand at about 9 notches a second. */
const WHEEL_GAPS = [110, 100, 120, 105, 115, 100, 110, 120, 105, 115, 100, 110, 120, 105];
/** A light TrackPoint push: 4.000244 px about every 150 ms (ADR 045's capture). */
const TRACKPOINT_LIGHT_GAPS = [150, 145, 155, 150, 148, 152, 150, 150];
/** A hard TrackPoint push, ramping up to about 335 px and back, every 29-45 ms (ADR 045). */
const TRACKPOINT_HARD: readonly [number, number][] = [
  [300, 18.5],
  [38, 46.25],
  [31, 92.75],
  [44, 151.25],
  [29, 213.5],
  [36, 268.25],
  [42, 312.75],
  [33, 334.75],
  [45, 329.5],
  [30, 301.25],
  [39, 247.25],
  [35, 176.5],
  [41, 104.25],
  [32, 52.75],
  [37, 21.5],
];

/** Every profile, by name. */
export const INPUT_PROFILES: Record<InputName, InputProfile> = {
  trackpad: {
    name: 'trackpad',
    description: 'a slow trackpad scroll: 2.5 px every 16 ms, 150 events',
    events: repeat(150, 16, 2.5),
  },
  wheel: {
    name: 'wheel',
    description: 'a mouse wheel: 14 notches of 100 px, 100-120 ms apart',
    events: WHEEL_GAPS.map((gapMs) => ({ gapMs, deltaPx: 100 })),
  },
  trackpoint: {
    name: 'trackpoint',
    description: 'a TrackPoint: 8 light 4.000244 px steps, then a hard push of 15 deltas',
    events: [
      ...TRACKPOINT_LIGHT_GAPS.map((gapMs) => ({ gapMs, deltaPx: 4.000244 })),
      ...TRACKPOINT_HARD.map(([gapMs, deltaPx]) => ({ gapMs, deltaPx })),
    ],
  },
};

/** The profile names, in the order the benchmark plays them by default. */
export const INPUT_NAMES = Object.keys(INPUT_PROFILES) as InputName[];

/** Whether `name` is a known input profile. */
export function isInputName(name: string): name is InputName {
  return Object.hasOwn(INPUT_PROFILES, name);
}

/** The profile's events with signed deltas for `direction` (up is a negative deltaY). */
export function signedEvents(profile: InputProfile, direction: Direction): WheelEvent[] {
  const sign = direction === 'up' ? -1 : 1;
  return profile.events.map((e) => ({ gapMs: e.gapMs, deltaPx: sign * e.deltaPx }));
}

/** How long the profile takes to send, in ms. */
export function durationMs(profile: InputProfile): number {
  return profile.events.reduce((sum, e) => sum + e.gapMs, 0);
}

/** The clock playInput waits on; tests pass a fake one. */
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const REAL_CLOCK: Clock = {
  now: () => performance.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * Plays `profile` at (x, y). Each event is due at the sum of the gaps before it, measured
 * from the start, so a slow CDP round trip delays one event instead of every later one.
 */
export async function playInput(
  cdp: Pick<Cdp, 'wheel'>,
  profile: InputProfile,
  direction: Direction,
  at: { x: number; y: number },
  clock: Clock = REAL_CLOCK,
): Promise<void> {
  const start = clock.now();
  let due = 0;
  for (const event of signedEvents(profile, direction)) {
    due += event.gapMs;
    const wait = start + due - clock.now();
    if (wait > 0) await clock.sleep(wait);
    await cdp.wheel(at.x, at.y, event.deltaPx);
  }
}
