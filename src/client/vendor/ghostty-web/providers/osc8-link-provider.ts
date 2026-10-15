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

  /** Provide all OSC 8 links on the given row. */
  provideLinks(y: number, callback: (links: ILink[] | undefined) => void): void {
    const line = this.terminal.buffer.active.getLine(y);
    if (!line) {
      callback(undefined);
      return;
    }

    const links: ILink[] = [];
    for (let x = 0; x < line.length; x++) {
      const link = this.linkAt(line, x, y);
      if (!link) continue;
      links.push(link);
      // The link covers its whole run of cells, so the scan resumes after its last one
      x = link.range.end.x;
    }

    callback(links.length > 0 ? links : undefined);
  }

  /** The link whose run starts at column `x` of buffer row `y`, or null if that cell has none. */
  private linkAt(line: OSC8Line, x: number, y: number): ILink | null {
    const cell = line.getCell(x);
    if (!cell || cell.getHyperlinkId() === 0) return null;

    const wasmTerm = this.terminal.wasmTerm;
    if (!wasmTerm) return null;
    // y is a buffer row (0 = oldest): a row above the viewport is read through the
    // scrollback API, whose offset also counts from the oldest row
    const viewportRow = y - wasmTerm.getScrollbackLength();
    const uriAt = (col: number): string | null =>
      viewportRow < 0
        ? wasmTerm.getScrollbackHyperlinkUri(y, col)
        : wasmTerm.getHyperlinkUri(viewportRow, col);

    const uri = uriAt(x);
    if (!uri) return null;

    // The run ends before a cell without a hyperlink or with a different URI
    let endX = x;
    for (let col = x + 1; col < line.length; col++) {
      const nextCell = line.getCell(col);
      if (!nextCell || nextCell.getHyperlinkId() === 0 || uriAt(col) !== uri) break;
      endX = col;
    }

    const range: IBufferRange = {
      start: { x, y },
      end: { x: endX, y },
    };
    return {
      text: uri,
      range,
      // Opens with Ctrl/Cmd held (ADR 061: one rule for both providers)
      activate: (event) => openLinkOnModifier(uri, event, this.open),
    };
  }

  dispose(): void {
    // No resources to clean up
  }
}

/** One buffer row as the provider reads it. */
type OSC8Line = NonNullable<ReturnType<ITerminalForOSC8Provider['buffer']['active']['getLine']>>;

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
