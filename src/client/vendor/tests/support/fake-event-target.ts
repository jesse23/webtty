// The smallest DOM a vendored Terminal can open on (test fake, ADR 064): an element, a
// document and a window, each a RecordingTarget that logs its listeners into one shared
// timeline, so a test reads every listener open() adds, in order, and which dispose() removes.

import { type ListenerRecord, RecordingTarget } from '../../../test-support/recording-target';
import { fakeContext2d } from './fake-canvas';

/** An element: attributes, style, children and focus, on a recording target. */
export class FakeElement extends RecordingTarget {
  readonly style: Record<string, string> = {};
  readonly dataset: Record<string, string> = {};
  readonly children: FakeElement[] = [];
  parentNode: FakeElement | null = null;
  width = 0;
  height = 0;
  /** Set on a canvas only: a context that draws nothing. */
  getContext?: () => CanvasRenderingContext2D;
  private readonly attributes = new Map<string, string>();

  constructor(
    name: string,
    readonly tagName: string,
    readonly ownerDocument: FakeDocument,
  ) {
    super(name);
    this.timeline = ownerDocument.timeline;
  }

  hasAttribute(key: string): boolean {
    return this.attributes.has(key);
  }

  setAttribute(key: string, value: string): void {
    this.attributes.set(key, value);
  }

  removeAttribute(key: string): void {
    this.attributes.delete(key);
  }

  appendChild<T extends FakeElement>(child: T): T {
    return this.insertBefore(child, null);
  }

  insertBefore<T extends FakeElement>(child: T, before: FakeElement | null): T {
    child.parentNode?.removeChild(child);
    const at = before ? this.children.indexOf(before) : -1;
    this.children.splice(at < 0 ? this.children.length : at, 0, child);
    child.parentNode = this;
    return child;
  }

  removeChild<T extends FakeElement>(child: T): T {
    const at = this.children.indexOf(child);
    if (at >= 0) this.children.splice(at, 1);
    child.parentNode = null;
    return child;
  }

  remove(): void {
    this.parentNode?.removeChild(this);
  }

  focus(): void {
    this.ownerDocument.activeElement = this;
  }
}

/**
 * A document that creates fake elements, naming each from `names` (by tag, in creation
 * order) so a listener record says which canvas or textarea it is on.
 */
export class FakeDocument extends RecordingTarget {
  activeElement: FakeElement | null = null;
  visibilityState: DocumentVisibilityState = 'visible';
  /** Every element created, in order. */
  readonly created: FakeElement[] = [];
  private readonly made = new Map<string, number>();

  constructor(
    timeline: ListenerRecord[],
    private readonly names: Record<string, string[]> = {},
  ) {
    super('document');
    this.timeline = timeline;
  }

  createElement(tag: string): FakeElement {
    const index = this.made.get(tag) ?? 0;
    this.made.set(tag, index + 1);
    const element = new FakeElement(this.names[tag]?.[index] ?? `${tag}#${index + 1}`, tag, this);
    if (tag === 'canvas') {
      const context = fakeContext2d();
      element.getContext = () => context;
    }
    this.created.push(element);
    return element;
  }
}

/** A media query list on a recording target, as `matchMedia` returns it. */
export class FakeMediaQueryList extends RecordingTarget {
  readonly matches = false;

  constructor(readonly media: string) {
    super('mediaQuery');
  }
}

/**
 * A window at device pixel ratio 1 whose intervals are logged and never run, so nothing
 * the terminal schedules on it fires after the test.
 */
export class FakeWindow extends RecordingTarget {
  readonly devicePixelRatio = 1;
  /** The delay of every interval set, in order. */
  readonly intervals: number[] = [];
  /** The media queries `matchMedia` handed out, in order. */
  readonly mediaQueries: FakeMediaQueryList[] = [];

  constructor(timeline: ListenerRecord[]) {
    super('window');
    this.timeline = timeline;
  }

  matchMedia(media: string): FakeMediaQueryList {
    const query = new FakeMediaQueryList(media);
    query.timeline = this.timeline;
    this.mediaQueries.push(query);
    return query;
  }

  setInterval(_handler: () => void, ms = 0): number {
    return this.intervals.push(ms);
  }

  clearTimeout(): void {}

  clearInterval(): void {}
}
