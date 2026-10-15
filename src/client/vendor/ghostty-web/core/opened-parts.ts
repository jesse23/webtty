// Derived from coder/ghostty-web lib/terminal.ts (MIT, see LICENSE and PROVENANCE.md in ghostty-web/).
// What Terminal.open() creates (types + util): the parts held together while the terminal
// is open, seen through narrow interfaces so core/ never imports a facade class, and
// their teardown, which also takes down a set left partial by a failed open() (ADR 061,
// ADR 065).

import type { GhosttyTerminal } from '../engine/engine-types';
import type { Disposable } from '../lifecycle/disposable-store';
import type { SearchHighlights } from '../search';
import type { LinkSource, MenuSelection, MouseRenderer } from './host-types';

/**
 * What the controllers reach of the CanvasRenderer: the mouse's reads, the find
 * highlights, the sub-line offset the view keeps across output (ADR 066) and its teardown.
 */
export interface RendererPart extends MouseRenderer {
  setSearchHighlights(highlights: SearchHighlights | null): void;
  readonly requestedOffset: number;
  dispose(): void;
}

/** What the controllers reach of the SelectionManager: the right-click calls and teardown. */
export interface SelectionPart extends MenuSelection {
  dispose(): void;
}

/** The InputHandler, which only the teardown reaches. */
export interface InputPart {
  dispose(): void;
}

/** What the controllers reach of the LinkDetector: lookups, the stale cache and teardown. */
export interface LinksPart extends LinkSource {
  /** The content changed: cached links may no longer be there. */
  invalidateCache(): void;
  dispose(): void;
}

/**
 * Everything open() creates, made in one place and held together, so a method that needs
 * an open terminal takes them from one check instead of asserting each field. The facade
 * passes the parts' classes; core/ sees only the interfaces, the defaults.
 */
export interface OpenedParts<
  R extends RendererPart = RendererPart,
  I extends InputPart = InputPart,
  S extends SelectionPart = SelectionPart,
  L extends LinksPart = LinksPart,
> {
  readonly element: HTMLElement;
  /** The listeners of the DOM setup (core/dom-setup.ts) on the container and canvas (ADR 065). */
  readonly domListeners: Disposable;
  /** reset() replaces it with a new engine. */
  engine: GhosttyTerminal;
  readonly canvas: HTMLCanvasElement;
  readonly textarea: HTMLTextAreaElement;
  readonly renderer: R;
  readonly input: I;
  readonly selection: S;
  readonly links: L;
}

/** The parts made so far while open() runs, noted one by one for a failure's teardown. */
export type PartsMade<P extends OpenedParts = OpenedParts> = { -readonly [K in keyof P]?: P[K] };

/** The parts' teardown calls, narrowed so tests pass fakes. */
export type DisposableParts = {
  [K in keyof OpenedParts]?: K extends 'element' | 'canvas' | 'textarea'
    ? Node
    : K extends 'engine'
      ? Pick<GhosttyTerminal, 'free'>
      : { dispose(): void };
};

/**
 * Disposes the selection, input and renderer, takes the canvas and textarea out of the
 * container, disposes the links and the DOM setup's listeners and frees the engine; parts
 * not made are skipped.
 */
export function disposeParts(parts: DisposableParts): void {
  parts.selection?.dispose();
  parts.input?.dispose();
  parts.renderer?.dispose();
  for (const node of [parts.canvas, parts.textarea]) {
    if (node?.parentNode) node.parentNode.removeChild(node);
  }
  parts.links?.dispose();
  parts.domListeners?.dispose();
  parts.engine?.free();
}
