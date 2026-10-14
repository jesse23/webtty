// Kitty graphics for the tab (feature, ADR 032, ADR 041, ADR 060). The wasm32
// libghostty-vt build leaves kitty graphics out and discards the protocol's APC
// sequences, so PTY output goes through this feature's feed() instead of term.write().

import type { ClientContext, Feature } from '../../app/client-context';
import { BROWSER_DECODER, type ImageDecoderDeps } from './graphics/image-decoder';
import { KittyGraphics } from './graphics/kitty-graphics';
import type { OverlayDeps } from './graphics/overlay-canvas';

/** What kitty graphics needs besides the context. */
export interface KittyDeps {
  /**
   * Sends a reply to the PTY as if typed. The root's connection is created after this
   * feature, so the root passes a function that reads it only when a reply is sent.
   */
  send(data: string): void;
  /** The pixel ratio and the frames the overlay repaints on. */
  window: OverlayDeps['window'];
  /** The browser's image constructors by default. */
  decoder?: ImageDecoderDeps;
}

/** The graphics API the output pipeline, the connection and Cmd+K use. */
export interface KittyFeature extends Feature {
  /** Writes PTY output to the terminal, taking the graphics commands out (hot path). */
  feed(data: string): void;
  /** Forgets the previous PTY stream's images and partial commands, on every (re)open. */
  reset(): void;
  /** Drops the placements, as the screen they were on is gone (ADR 054). */
  clear(): void;
}

/**
 * Lays the overlay canvas over the terminal (into the container, with a document
 * `visibilitychange` listener). The KittyGraphics itself is returned, not a wrapper, so
 * the per-message feed() stays one direct call.
 */
export function installKitty(ctx: ClientContext, deps: KittyDeps): KittyFeature {
  return new KittyGraphics(
    ctx.term,
    ctx.container,
    deps.send,
    {},
    {
      document: ctx.doc,
      window: deps.window,
      decoder: deps.decoder ?? BROWSER_DECODER,
    },
  );
}
