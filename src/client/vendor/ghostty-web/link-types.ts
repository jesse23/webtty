// Derived from coder/ghostty-web lib/types.ts (MIT, see LICENSE and PROVENANCE.md in ghostty-web/).
// The link detection contract (types): buffer positions and ranges, a detected link, and the
// provider interface the OSC 8 and URL regex providers implement (ADR 061).

/** A cell in the buffer, by absolute row, where links are found and hovered. */
export interface IBufferCellPosition {
  x: number; // Column (0-based)
  y: number; // Row (0-based, absolute buffer position)
}

/** The cells a link covers; it can span rows when the link wraps. */
export interface IBufferRange {
  start: IBufferCellPosition;
  end: IBufferCellPosition; // Inclusive
}

/** A detected link: what the renderer underlines and a modifier click opens. */
export interface ILink {
  /** The URL or text of the link */
  text: string;

  /** The range of the link in the buffer (may span multiple lines) */
  range: IBufferRange;

  /** Called when the link is activated (clicked with modifier) */
  activate(event: MouseEvent): void;

  /** Optional: called when mouse enters/leaves the link */
  hover?(isHovered: boolean): void;
}

/**
 * Finds one kind of link on a row (OSC 8 hyperlinks, URLs by regex), so the link detector
 * can ask each provider in turn.
 */
export interface ILinkProvider {
  /**
   * Provide links for a given row
   * @param y Absolute row in buffer (0-based)
   * @param callback Called with detected links (or undefined if none)
   */
  provideLinks(y: number, callback: (links: ILink[] | undefined) => void): void;

  /** Optional: called when terminal is disposed */
  dispose?(): void;
}
