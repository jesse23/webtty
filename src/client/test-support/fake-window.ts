// The window as the client root uses it, as a fake (test fake, ADR 064): a RecordingTarget
// named `window` for the listener-order tests, with a settable devicePixelRatio and a
// matchMedia whose queries are recording targets too, so a DPR change can be played.

import type { ClientWindow } from '../app/browser-env';
import { RecordingTarget } from './recording-target';

/** A media query list the test can fire `change` on; it records its own listeners. */
export class FakeMediaQuery extends RecordingTarget {
  readonly matches = true;

  constructor(readonly media: string) {
    super(`media ${media}`);
  }
}

/** A fake `ClientWindow`: records its listeners, the queries asked for, and close/focus calls. */
export class FakeWindow extends RecordingTarget {
  devicePixelRatio = 1;
  readonly location: Location;
  /** Every media query asked for, in order. */
  readonly queries: FakeMediaQuery[] = [];
  /** `close` and `focus` calls, in order. */
  readonly calls: string[] = [];

  constructor(url = 'http://localhost/s/test') {
    super('window');
    // URL has the fields the client reads from location (protocol, host, pathname).
    this.location = new URL(url) as unknown as Location;
  }

  readonly matchMedia = (media: string): FakeMediaQuery => {
    const query = new FakeMediaQuery(media);
    this.queries.push(query);
    return query;
  };

  close(): void {
    this.calls.push('close');
  }

  focus(): void {
    this.calls.push('focus');
  }

  /** The fake typed as the window the client takes. */
  asWindow(): ClientWindow {
    // The fake covers the members the client uses, not the whole MediaQueryList.
    return this as unknown as ClientWindow;
  }
}
