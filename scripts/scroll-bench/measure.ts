// One measurement in an open page: start the scenario's app in the session, then record a
// scroll with an input profile and reduce it to numbers, either blinks and paints (the
// scroll test) or whether the view held still while output streamed (the stream test).
// Service over Cdp; the numbers come from metrics.ts.

import { type Cdp, sleep } from './cdp';
import { type Direction, type InputProfile, playInput } from './inputs';
import {
  averageStepPx,
  blinkFrames,
  matchPairs,
  type PaintStats,
  paintStats,
  SCROLL_WINDOW,
  type StreamStats,
  streamStats,
} from './metrics';
import { decodeProfiles, readPaintCounter, resetPaintCounter, viewportCentre } from './page';
import type { Scenario } from './scenarios';
import { type CastOptions, startRecording } from './screencast';

const CAST: CastOptions = { quality: 80, maxWidth: 1280, maxHeight: 800 };
/** How long to wait for the client to draw its terminal canvas after the page loads. */
const READY_TIMEOUT_MS = 10_000;
/** Recording kept after the last wheel event, so glides and late paints are seen. */
const TAIL_MS = 400;
/** The stream test watches the view at rest this long after the scroll. */
const STREAM_REST_MS = 1500;
/** Settle time after a stream test's scroll before at-rest frames count. */
const STREAM_SETTLE_MS = 300;

/** Waits until the page shows a canvas, the client's terminal. */
async function waitForTerminal(cdp: Cdp): Promise<void> {
  const until = Date.now() + READY_TIMEOUT_MS;
  while (!(await cdp.eval<boolean>(`!!document.querySelector('canvas')`))) {
    if (Date.now() > until) throw new Error('the terminal canvas never appeared');
    await sleep(100);
  }
}

/** Opens `url`, types the scenario's command at the shell prompt and waits for its app. */
export async function startScenario(cdp: Cdp, url: string, scenario: Scenario): Promise<void> {
  await cdp.navigate(url);
  await waitForTerminal(cdp);
  await sleep(500);
  const centre = await viewportCentre(cdp);
  await cdp.click(centre.x, centre.y);
  await cdp.text(scenario.command);
  await cdp.key('Enter');
  await sleep(scenario.waitMs);
  if (scenario.enter2) {
    await cdp.key('Enter');
    await sleep(scenario.enter2WaitMs);
  }
}

/** The scroll test's numbers for one input. */
export interface ScrollMeasure extends PaintStats {
  frames: number;
  blinks: number;
  avgStepPx: number;
}

/**
 * Plays `input` while recording the screencast and the paint counter, then counts
 * blinks (transient frames), paints per second, paint gaps and the average step.
 */
export async function measureScroll(
  cdp: Cdp,
  input: InputProfile,
  direction: Direction,
): Promise<ScrollMeasure> {
  const centre = await viewportCentre(cdp);
  await resetPaintCounter(cdp);
  const recording = await startRecording(cdp, CAST);
  await playInput(cdp, input, direction, centre);
  await sleep(TAIL_MS);
  const cast = await recording.stop();
  const log = await readPaintCounter(cdp);
  const profiles = await decodeProfiles(
    cdp,
    cast.map((f) => f.jpeg),
    { x: 8, width: 600, channels: 'rg' },
  );
  const pairs = matchPairs(profiles, SCROLL_WINDOW);
  return {
    frames: profiles.length,
    blinks: blinkFrames(profiles, pairs, SCROLL_WINDOW).length,
    avgStepPx: averageStepPx(pairs),
    ...paintStats(log.frames, log.wheels, TAIL_MS),
  };
}

/**
 * Scrolls back with `input` while the scenario streams output on the normal screen, then
 * watches the view at rest: counts frames showing the bottom (the inverse status bar
 * stream.sh draws), during the scroll and after it, and at-rest frames that moved.
 */
export async function measureStream(
  cdp: Cdp,
  input: InputProfile,
  direction: Direction,
): Promise<StreamStats> {
  const centre = await viewportCentre(cdp);
  const recording = await startRecording(cdp, CAST);
  await playInput(cdp, input, direction, centre);
  const scrollEnd = Date.now();
  await sleep(STREAM_SETTLE_MS + STREAM_REST_MS);
  const cast = await recording.stop();
  const profiles = await decodeProfiles(
    cdp,
    cast.map((f) => f.jpeg),
    { x: 0, width: 4000, channels: 'r' },
  );
  const frames = cast.map((f, i) => ({ time: f.time, profile: profiles[i] }));
  return streamStats(frames, scrollEnd, STREAM_SETTLE_MS);
}
