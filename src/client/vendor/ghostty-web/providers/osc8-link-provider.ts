// Derived from coder/ghostty-web lib/providers/osc8-link-provider.ts (MIT, see LICENSE and PROVENANCE.md in ghostty-web/).
// OSC 8 hyperlinks (strategy: an ILinkProvider): runs of cells on a row that carry the
// same hyperlink URI, written as \x1b]8;;URL\x07TEXT\x1b]8;;\x07, read from the screen
// or the scrollback (ADR 061).

import type { IBufferRange, ILink, ILinkProvider } from '../link-types';
import { type LinkOpener, openLinkOnModifier, windowOpen } from './open-link';

/**
 * Detects OSC 8 hyperlinks by scanning a row for cells with a hyperlink and grouping
 * neighbours with the same URI. Each link covers one row: a link wrapped onto the next
 * row is found again, as its own link, when that row is scanned.
 */
export class OSC8LinkProvider implements ILinkProvider {
  /** `open` opens an activated link; the page's `window.open` by default. */
  constructor(
    private terminal: ITerminalForOSC8Provider,
    private readonly open: LinkOpener = windowOpen
  ) {}

  /**
   * Provide all OSC 8 links on the given row
   */
  provideLinks(y: number, callback: (links: ILink[] | undefined) => void): void {
    const links: ILink[] = [];
    const visitedPositions = new Set<number>(); // Track which columns we've already processed

    const line = this.terminal.buffer.active.getLine(y);
    if (!line) {
      callback(undefined);
      return;
    }

    // Scan through this line looking for hyperlink_id
    for (let x = 0; x < line.length; x++) {
      // Skip already processed positions
      if (visitedPositions.has(x)) continue;

      const cell = line.getCell(x);
      if (!cell) continue;

      const hyperlinkId = cell.getHyperlinkId();

      // Skip cells without links
      if (hyperlinkId === 0) {
        continue;
      }

      // Get the URI from WASM
      // The y parameter is a buffer row - we need to determine if it's in
      // scrollback or the active viewport and use the appropriate API
      if (!this.terminal.wasmTerm) continue;
      const scrollbackLength = this.terminal.wasmTerm.getScrollbackLength();
      const viewportRow = y - scrollbackLength;

      let uri: string | null;
      if (viewportRow < 0) {
        // Row is in scrollback - use scrollback API
        // y is the buffer row (0 = oldest), scrollback offset is also 0 = oldest
        uri = this.terminal.wasmTerm.getScrollbackHyperlinkUri(y, x);
      } else {
        // Row is in active viewport
        uri = this.terminal.wasmTerm.getHyperlinkUri(viewportRow, x);
      }

      if (uri) {
        // Find the end of this link by scanning forward until we hit a cell
        // without a hyperlink or with a different URI
        let endX = x;
        for (let col = x + 1; col < line.length; col++) {
          const nextCell = line.getCell(col);
          if (!nextCell || nextCell.getHyperlinkId() === 0) break;

          // Check if this cell has the same URI (use appropriate API for scrollback vs viewport)
          const nextUri =
            viewportRow < 0
              ? this.terminal.wasmTerm!.getScrollbackHyperlinkUri(y, col)
              : this.terminal.wasmTerm!.getHyperlinkUri(viewportRow, col);
          if (nextUri !== uri) break;

          endX = col;
        }

        // Mark all columns in this link as visited
        for (let col = x; col <= endX; col++) {
          visitedPositions.add(col);
        }

        const range: IBufferRange = {
          start: { x, y },
          end: { x: endX, y },
        };

        links.push({
          text: uri,
          range,
          // Opens with Ctrl/Cmd held (ADR 061: one rule for both providers)
          activate: (event) => openLinkOnModifier(uri, event, this.open),
        });
      }
    }

    callback(links.length > 0 ? links : undefined);
  }

  dispose(): void {
    // No resources to clean up
  }
}

/**
 * Minimal terminal interface required by OSC8LinkProvider
 */
export interface ITerminalForOSC8Provider {
  buffer: {
    active: {
      length: number;
      getLine(y: number):
        | {
            length: number;
            getCell(x: number):
              | {
                  getHyperlinkId(): number;
                }
              | undefined;
          }
        | undefined;
    };
  };
  wasmTerm?: {
    getHyperlinkUri(row: number, col: number): string | null;
    getScrollbackHyperlinkUri(offset: number, col: number): string | null;
    getScrollbackLength(): number;
  };
}
