// Derived from coder/ghostty-web lib/terminal.ts (MIT, see LICENSE and PROVENANCE.md in ghostty-web/).
// What Terminal.open() creates (types + util): the parts held together while the terminal
// is open, and their teardown, which also takes down a set left partial by a failed
// open() (ADR 061).

import type { GhosttyTerminal } from '../engine/engine-types';
import type { InputHandler } from '../input-handler';
import type { LinkDetector } from '../link-detector';
import type { CanvasRenderer } from '../renderer';
import type { SelectionManager } from '../selection-manager';

/**
 * Everything open() creates, made in one place and held together, so a method that needs
 * an open terminal takes them from one check instead of asserting each field.
 */
export interface OpenedParts {
  readonly element: HTMLElement;
  /** reset() replaces it with a new engine. */
  engine: GhosttyTerminal;
  readonly canvas: HTMLCanvasElement;
  readonly textarea: HTMLTextAreaElement;
  readonly renderer: CanvasRenderer;
  readonly input: InputHandler;
  readonly selection: SelectionManager;
  readonly links: LinkDetector;
}

/** The parts made so far while open() runs, noted one by one for a failure's teardown. */
export type PartsMade = { -readonly [K in keyof OpenedParts]?: OpenedParts[K] };

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
 * container, disposes the links and frees the engine; parts not made are skipped.
 */
export function disposeParts(parts: DisposableParts): void {
  parts.selection?.dispose();
  parts.input?.dispose();
  parts.renderer?.dispose();
  for (const node of [parts.canvas, parts.textarea]) {
    if (node?.parentNode) node.parentNode.removeChild(node);
  }
  parts.links?.dispose();
  parts.engine?.free();
}
