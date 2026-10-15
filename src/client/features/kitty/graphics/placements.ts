// Where images are placed on the terminal grid (object, ADR 032): one placement per image
// and placement id, anchored to an absolute buffer row so it scrolls with its text.

import type { Scale } from './kitty-terminal';

/** One image shown at a cell, with the source rectangle and offsets the command gave. */
export interface Placement {
  imageId: number;
  placementId: number;
  /** Row in absolute buffer coordinates: scrollback length + viewport row. */
  absRow: number;
  col: number;
  cols?: number;
  rows?: number;
  srcX: number;
  srcY: number;
  srcW: number;
  srcH: number;
  offX: number;
  offY: number;
  /** Device pixels per CSS pixel when placed; the image was sized for this. */
  scale: Scale;
}

/** The placement table, in the order placements were made (the order they are drawn in). */
export class Placements {
  private readonly table = new Map<string, Placement>();

  /** Number of placements on the grid. */
  get size(): number {
    return this.table.size;
  }

  /** Keys as `<imageId>:<placementId>`, in placement order. */
  keys(): string[] {
    return [...this.table.keys()];
  }

  /** Placements in the order they are drawn. */
  values(): IterableIterator<Placement> {
    return this.table.values();
  }

  /** Records `p`, replacing an earlier placement with the same image and placement id. */
  add(p: Placement): void {
    this.table.set(`${p.imageId}:${p.placementId}`, p);
  }

  /** Removes every placement `match` accepts; returns whether any was removed. */
  removeWhere(match: (p: Placement) => boolean): boolean {
    let removed = false;
    for (const [key, p] of this.table) {
      if (!match(p)) continue;
      this.table.delete(key);
      removed = true;
    }
    return removed;
  }

  /** Removes every placement. */
  clear(): void {
    this.table.clear();
  }
}
