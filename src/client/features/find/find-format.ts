// How the find bar words the match count (util, pure, ADR 055): Ghostty's `selected/total`
// for the eye and a sentence for a screen reader.

/** The match count and the selected match's index (0 the newest), as the terminal reports them. */
export interface FindState {
  total: number;
  selected: number | null;
}

/** The count as Ghostty's search overlay shows it: `0/n` until a match is selected. */
export function countLabel(state: FindState): string {
  if (state.total === 0) return '0/0';
  return `${state.selected === null ? 0 : state.selected + 1}/${state.total}`;
}

/** The count for a screen reader, announced through the bar's live region. */
export function countDescription(state: FindState): string {
  if (state.total === 0) return 'No matches';
  const matches = state.total === 1 ? '1 match' : `${state.total} matches`;
  if (state.selected === null) return matches;
  return `Match ${state.selected + 1} of ${state.total}`;
}
