// Hooks wheel scrolling into the terminal (feature, ADR 017, ADR 040, ADR 045, ADR 060).
// WheelStream tells a mouse wheel, a trackpad and a TrackPoint apart and picks how each
// event moves: on the normal screen, unless the app tracks the mouse, SmoothScroll glides
// the scrollback pixel by pixel, advanced just before each render; otherwise the terminal
// sends the app mouse wheel reports in the app's mouse format (ADR 049), or arrow keys on
// the alternate screen, paced the same way.

import type { ClientContext, Feature } from '../../app/client-context';
import { toDisposable } from '../../vendor/ghostty-web';
import type { SmoothScroll } from './smooth-scroll';
import type { WheelStream } from './wheel-stream';

/** What the scroll hooks need besides the context: the objects the root built at the layout step. */
export interface ScrollDeps {
  /** Built before the layout, which re-reads its row height after every fit. */
  smoothScroll: Pick<SmoothScroll, 'handleWheel' | 'frame'>;
  wheelStream: Pick<WheelStream, 'forApp'>;
}

/** The installed scroll hooks; nothing to call, only to dispose. */
export type ScrollFeature = Feature;

/** Attaches the custom wheel handler, the wheel pace and the before-render hook. */
export function installScroll(ctx: ClientContext, deps: ScrollDeps): ScrollFeature {
  const { term } = ctx;
  const { smoothScroll, wheelStream } = deps;
  term.attachCustomWheelEventHandler(
    (e: WheelEvent): boolean => !term.hasMouseTracking() && smoothScroll.handleWheel(e),
  );
  term.attachWheelPace((e: WheelEvent) => wheelStream.forApp(e));
  term.attachBeforeRender((now: number) => smoothScroll.frame(now));
  // The terminal holds one of each, so detaching is setting them back to none.
  return toDisposable(() => {
    term.attachCustomWheelEventHandler();
    term.attachWheelPace();
    term.attachBeforeRender();
  });
}
