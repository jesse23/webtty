import { describe, expect, test } from 'bun:test';
import { type Placement, Placements } from './placements';

const at = (imageId: number, placementId: number, col = 0): Placement => ({
  imageId,
  placementId,
  absRow: 0,
  col,
  srcX: 0,
  srcY: 0,
  srcW: 0,
  srcH: 0,
  offX: 0,
  offY: 0,
  scale: { x: 1, y: 1 },
});

describe('Placements', () => {
  test('keeps placement order and replaces a repeated image and placement id in place', () => {
    const table = new Placements();
    table.add(at(1, 0));
    table.add(at(2, 0));
    table.add(at(1, 0, 5));
    expect(table.keys()).toEqual(['1:0', '2:0']);
    expect([...table.values()].map((p) => p.col)).toEqual([5, 0]);
    expect(table.size).toBe(2);
  });

  test('removeWhere removes the matches and says whether there were any', () => {
    const table = new Placements();
    table.add(at(1, 0));
    table.add(at(1, 1));
    table.add(at(2, 0));
    expect(table.removeWhere((p) => p.imageId === 1)).toBe(true);
    expect(table.keys()).toEqual(['2:0']);
    expect(table.removeWhere((p) => p.imageId === 1)).toBe(false);
  });

  test('clear empties the table', () => {
    const table = new Placements();
    table.add(at(1, 0));
    table.clear();
    expect(table.size).toBe(0);
  });
});
