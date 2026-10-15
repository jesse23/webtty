// Derived from coder/ghostty-web lib/link-detector.ts (MIT, see LICENSE and PROVENANCE.md in ghostty-web/).
// Link detection and caching (object): `LinkDetector` asks its providers for the links on a
// row and caches them by position range; earlier providers (OSC 8) take precedence over
// later ones (the URL regex). The terminal's mouse controller reads it on hover and click.

import { cellInRange } from './render/cell-range';
import type { ILink, ILinkProvider } from './link-types';

/**
 * Manages link detection across multiple providers with intelligent caching
 */
export class LinkDetector {
  private providers: ILinkProvider[] = [];

  // Cache links by position range: `r${row}:${startX}-${endX}`
  private linkCache = new Map<string, ILink>();

  // Track which rows have been scanned to avoid redundant provider calls
  private scannedRows = new Set<number>();

  // Terminal instance for buffer access
  constructor(private terminal: ITerminalForLinkDetector) {}

  /**
   * Register a link provider
   */
  registerProvider(provider: ILinkProvider): void {
    this.providers.push(provider);
    this.invalidateCache(); // New provider may detect different links
  }

  /**
   * Get link at the specified buffer position
   * @param col Column (0-based)
   * @param row Absolute row in buffer (0-based)
   * @returns Link at position, or undefined if none
   */
  async getLinkAt(col: number, row: number): Promise<ILink | undefined> {
    const line = this.terminal.buffer.active.getLine(row);
    if (!line || col < 0 || col >= line.length) {
      return undefined;
    }

    const cell = line.getCell(col);
    if (!cell) {
      return undefined;
    }

    // Check if any cached link contains this position (fast path)
    for (const link of this.linkCache.values()) {
      if (this.isPositionInLink(col, row, link)) {
        return link;
      }
    }

    // Slow path: scan this row if not already scanned
    if (!this.scannedRows.has(row)) {
      await this.scanRow(row);
    }

    // Check cache again after scanning
    for (const link of this.linkCache.values()) {
      if (this.isPositionInLink(col, row, link)) {
        return link;
      }
    }

    return undefined;
  }

  /**
   * Scan a row for links using all registered providers
   */
  private async scanRow(row: number): Promise<void> {
    this.scannedRows.add(row);

    const allLinks: ILink[] = [];

    // Query all providers
    for (const provider of this.providers) {
      const links = await new Promise<ILink[] | undefined>((resolve) => {
        provider.provideLinks(row, resolve);
      });

      if (links) {
        allLinks.push(...links);
      }
    }

    // Cache all discovered links
    for (const link of allLinks) {
      this.cacheLink(link);
    }
  }

  /**
   * Cache a link for fast lookup
   *
   * Note: We cache by position range, not hyperlink_id, because the WASM
   * returns hyperlink_id as a boolean (0 or 1), not a unique identifier.
   * The actual unique identifier is the URI which is retrieved separately.
   */
  private cacheLink(link: ILink): void {
    // Cache by position range - this uniquely identifies links even when
    // multiple OSC 8 links exist on the same line
    const { start: s, end: e } = link.range;
    const cacheKey = `r${s.y}:${s.x}-${e.x}`;
    // Don't overwrite existing entries - earlier providers (OSC8) take
    // precedence over later ones (regex) for the same range
    if (!this.linkCache.has(cacheKey)) {
      this.linkCache.set(cacheKey, link);
    }
  }

  /**
   * Check if a position is within a link's range (the one inclusive test, ADR 061)
   */
  private isPositionInLink(col: number, row: number, link: ILink): boolean {
    const { start, end } = link.range;
    return cellInRange(
      { startCol: start.x, startRow: start.y, endCol: end.x, endRow: end.y },
      col,
      row
    );
  }

  /**
   * Invalidate cache when terminal content changes
   * Should be called on terminal write, resize, or clear
   */
  invalidateCache(): void {
    this.linkCache.clear();
    this.scannedRows.clear();
  }

  /**
   * Dispose and cleanup
   */
  dispose(): void {
    this.linkCache.clear();
    this.scannedRows.clear();

    // Dispose all providers
    for (const provider of this.providers) {
      provider.dispose?.();
    }
    this.providers = [];
  }
}

/**
 * Minimal terminal interface required by LinkDetector
 * Keeps coupling low and testing easy
 */
export interface ITerminalForLinkDetector {
  buffer: {
    active: {
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
}
