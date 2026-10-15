import { beforeAll, describe, expect, test } from 'bun:test';
import { EngineContext } from '../../ghostty-web/engine/engine-context';
import type { Ghostty } from '../../ghostty-web/ghostty';
import { freeContext, writeVt } from '../support/engine-harness';
import { countedGhostty, loadGhostty } from '../support/wasm';

// The shared engine state (ADR 061): its scratch slots, fresh memory views, the terminal
// info read once per generation, and the option and viewport calls.

let vt: Ghostty;

beforeAll(async () => {
  vt = await loadGhostty();
});

describe('EngineContext', () => {
  test('creates the terminal and lays out its own slots and the bindings', () => {
    const ctx = new EngineContext(vt, 12, 4, { extra: [16, 8] });
    expect(ctx.term).not.toBe(0);
    expect([ctx.cols, ctx.rows, ctx.generation]).toEqual([12, 4, 1]);
    for (const slot of ['tKeys', 'tVals', 'scroll', 'u32', 'u8', 'extra'] as const) {
      expect(ctx.at[slot]).toBeGreaterThanOrEqual(ctx.scratch.base);
      expect(ctx.at[slot]).toBeLessThan(ctx.scratch.base + ctx.scratch.len);
    }
    expect(ctx.at.extra % 8).toBe(0);
    freeContext(ctx);
  });

  test('builds memory views on the current buffer at every call', () => {
    const ctx = new EngineContext(vt, 10, 3, {});
    expect(ctx.u8().buffer).toBe(ctx.ex.memory.buffer);
    expect(ctx.dv().buffer).toBe(ctx.ex.memory.buffer);
    expect(ctx.u8()).not.toBe(ctx.u8());
    ctx.setU32s(ctx.at.u32, [7, 9]);
    expect([
      ctx.dv().getUint32(ctx.at.u32, true),
      ctx.dv().getUint32(ctx.at.u32 + 4, true),
    ]).toEqual([7, 9]);
    freeContext(ctx);
  });

  test('reads the cursor, scrollback rows and screen once per generation', async () => {
    const { ghostty, calls } = await countedGhostty(['ghostty_terminal_get_multi']);
    const ctx = new EngineContext(ghostty, 10, 3, {});
    writeVt(ctx, '1\r\n2\r\n3\r\n4\r\n5ab');
    ctx.info();
    ctx.info();
    expect(calls.ghostty_terminal_get_multi).toBe(1);
    expect([ctx.cursorX, ctx.cursorY, ctx.sbRows, ctx.altScreen]).toEqual([3, 2, 2, false]);
    writeVt(ctx, '\x1b[?1049h');
    ctx.info();
    expect(calls.ghostty_terminal_get_multi).toBe(2);
    expect(ctx.altScreen).toBe(true);
    freeContext(ctx);
  });

  test('info throws when Ghostty refuses the read', () => {
    const ctx = new EngineContext(vt, 10, 3, {});
    const term = ctx.term;
    ctx.term = 0;
    ctx.generation++;
    expect(() => ctx.info()).toThrow('libghostty-vt terminal_get_multi failed');
    ctx.term = term;
    freeContext(ctx);
  });

  test('setOption names the option when Ghostty refuses it', () => {
    const ctx = new EngineContext(vt, 10, 3, {});
    const term = ctx.term;
    ctx.term = 0;
    expect(() => ctx.setOption(ctx.L.opt.MODE, ctx.at.u32, 'MODE')).toThrow(
      'libghostty-vt terminal_set MODE failed',
    );
    ctx.term = term;
    freeContext(ctx);
  });

  test('scrollViewport moves the viewport, which a bottom scroll puts back', () => {
    const ctx = new EngineContext(vt, 10, 2, { scrollbar: [vt.L.scrollbar.size, 8] });
    writeVt(ctx, '1\r\n2\r\n3\r\n4');
    const S = ctx.L.scroll;
    const top = () => {
      expect(ctx.ex.ghostty_terminal_get(ctx.term, ctx.L.tdata.SCROLLBAR, ctx.at.scrollbar)).toBe(
        0,
      );
      return ctx.dv().getUint32(ctx.at.scrollbar + ctx.L.scrollbar.offset, true);
    };
    expect(top()).toBe(2);
    ctx.scrollViewport(S.ROW, 1);
    expect(top()).toBe(1);
    ctx.scrollViewport(S.BOTTOM, 0);
    expect(top()).toBe(2);
    freeContext(ctx);
  });
});
