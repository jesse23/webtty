// Derived from coder/ghostty-web lib/providers/osc8-link-provider.ts and lib/providers/url-regex-provider.ts (MIT, see LICENSE and PROVENANCE.md in ghostty-web/).
// Link activation (util): the one rule both link providers open a link by, a click with
// Ctrl or Cmd held, in a new tab without an opener (ADR 061).

/** Opens a URL as `window.open` does; injected so tests see what would open. */
export type LinkOpener = (url: string, target: string, features: string) => unknown;

/** The page's `window.open`, read when a link is activated. */
export const windowOpen: LinkOpener = (url, target, features) =>
  window.open(url, target, features);

/** Opens `url` in a new tab when Ctrl or Cmd is held; a plain click opens nothing. */
export function openLinkOnModifier(
  url: string,
  event: Pick<MouseEvent, 'ctrlKey' | 'metaKey'>,
  open: LinkOpener = windowOpen,
): void {
  if (event.ctrlKey || event.metaKey) {
    open(url, '_blank', 'noopener,noreferrer');
  }
}
