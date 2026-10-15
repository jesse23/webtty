// The Cmd+K screen clear (util, pure, ADR 054): the root builds it from the terminal, the
// graphics and the smooth scroll, and passes it to the key dispatcher as `clearScreen`.

/**
 * Cmd+K: clears the screen, then the placements on it and any sub-line scroll offset.
 * Nothing on the alternate screen; the clear is this tab's own, and a reload replays the
 * session's output again.
 */
export function screenClearer(
  term: { clearScreen(): boolean },
  graphics: { clear(): void },
  smoothScroll: { onOutput(): void },
): () => boolean {
  return () => {
    if (!term.clearScreen()) return false;
    graphics.clear();
    smoothScroll.onOutput();
    return true;
  };
}
