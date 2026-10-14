import { beforeAll, describe, expect, test } from 'bun:test';
import { resolveOfficialLayout } from '../../ghostty-web/engine/official-layout';
import { type ManifestType, readVtLayout, VtLayout } from '../../ghostty-web/engine/vt-layout';
import type { OfficialWasmExports } from '../../ghostty-web/engine/wasm-exports';
import { instantiateWasm } from '../support/wasm';

// The binding's layout table resolved from the pinned wasm's own manifest (ADR 041).

let types: Record<string, ManifestType>;

beforeAll(async () => {
  const instance = await instantiateWasm();
  const ex = instance.exports as unknown as OfficialWasmExports;
  const memory = new Uint8Array(ex.memory.buffer);
  const p = ex.ghostty_type_json();
  const end = memory.indexOf(0, p);
  types = JSON.parse(new TextDecoder().decode(memory.subarray(p, end))).types;
  expect(readVtLayout(ex).size('GhosttyCell')).toBe(types.GhosttyCell.size);
});

/** The manifest with one type replaced, for the checks that must fail loudly. */
function withType(name: string, type: ManifestType | undefined): VtLayout {
  const copy = structuredClone(types);
  if (type) copy[name] = type;
  else delete copy[name];
  return new VtLayout(copy);
}

describe('resolveOfficialLayout', () => {
  test('resolves every name the binding uses from the pinned manifest', () => {
    const L = resolveOfficialLayout(new VtLayout(types));
    expect(L.cellSize).toBe(8);
    expect(L.point.SCREEN).toBe(new VtLayout(types).value('GhosttyPointTag', 'SCREEN'));
    expect(Object.keys(L.mouse.button)).toEqual([
      'left',
      'middle',
      'right',
      'four',
      'five',
      'eight',
      'nine',
    ]);
  });

  test('a type the binding needs missing from the manifest throws with its name', () => {
    expect(() => resolveOfficialLayout(withType('GhosttySearchStatus', undefined))).toThrow(
      'no type GhosttySearchStatus',
    );
  });

  test('codepoint arms that disagree throw', () => {
    const cell = structuredClone(types.GhosttyCell);
    const arm = cell.bits?.content?.arms?.CODEPOINT_GRAPHEME;
    if (!arm) throw new Error('the pinned manifest has no CODEPOINT_GRAPHEME arm');
    arm.bits.codepoint = { ...arm.bits.codepoint, lsb: arm.bits.codepoint.lsb + 1 };
    expect(() => resolveOfficialLayout(withType('GhosttyCell', cell))).toThrow(
      'codepoint arms differ',
    );
  });
});
