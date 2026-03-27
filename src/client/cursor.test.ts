import { describe, expect, mock, test } from 'bun:test';
import { applyDecscusr } from './cursor';

function makeTerm(): { options: { cursorStyle: string; cursorBlink: boolean } } {
  return { options: { cursorStyle: 'block', cursorBlink: false } };
}

function makeTermWithRenderer(): {
  options: { cursorStyle: string; cursorBlink: boolean };
  renderer: { render: ReturnType<typeof mock> };
  wasmTerm: object;
  viewportY: number;
} {
  return {
    options: { cursorStyle: 'block', cursorBlink: false },
    renderer: { render: mock(() => {}) },
    wasmTerm: {},
    viewportY: 0,
  };
}

describe('applyDecscusr', () => {
  test('Ps 0 — default reset — sets block blinking', () => {
    const term = makeTerm();
    applyDecscusr(term as never, '\x1b[0 q');
    expect(term.options.cursorStyle).toBe('block');
    expect(term.options.cursorBlink).toBe(true);
  });

  test('Ps 1 — blinking block', () => {
    const term = makeTerm();
    applyDecscusr(term as never, '\x1b[1 q');
    expect(term.options.cursorStyle).toBe('block');
    expect(term.options.cursorBlink).toBe(true);
  });

  test('Ps 2 — steady block', () => {
    const term = makeTerm();
    applyDecscusr(term as never, '\x1b[2 q');
    expect(term.options.cursorStyle).toBe('block');
    expect(term.options.cursorBlink).toBe(false);
  });

  test('Ps 3 — blinking underline', () => {
    const term = makeTerm();
    applyDecscusr(term as never, '\x1b[3 q');
    expect(term.options.cursorStyle).toBe('underline');
    expect(term.options.cursorBlink).toBe(true);
  });

  test('Ps 4 — steady underline', () => {
    const term = makeTerm();
    applyDecscusr(term as never, '\x1b[4 q');
    expect(term.options.cursorStyle).toBe('underline');
    expect(term.options.cursorBlink).toBe(false);
  });

  test('Ps 5 — blinking bar', () => {
    const term = makeTerm();
    applyDecscusr(term as never, '\x1b[5 q');
    expect(term.options.cursorStyle).toBe('bar');
    expect(term.options.cursorBlink).toBe(true);
  });

  test('Ps 6 — steady bar', () => {
    const term = makeTerm();
    applyDecscusr(term as never, '\x1b[6 q');
    expect(term.options.cursorStyle).toBe('bar');
    expect(term.options.cursorBlink).toBe(false);
  });

  test('empty Ps defaults to 0 (blinking block)', () => {
    const term = makeTerm();
    applyDecscusr(term as never, '\x1b[ q');
    expect(term.options.cursorStyle).toBe('block');
    expect(term.options.cursorBlink).toBe(true);
  });

  test('out-of-range Ps is ignored', () => {
    const term = makeTerm();
    term.options.cursorStyle = 'bar';
    term.options.cursorBlink = false;
    applyDecscusr(term as never, '\x1b[7 q');
    expect(term.options.cursorStyle).toBe('bar');
    expect(term.options.cursorBlink).toBe(false);
  });

  test('no DECSCUSR sequence leaves options unchanged', () => {
    const term = makeTerm();
    applyDecscusr(term as never, 'hello world');
    expect(term.options.cursorStyle).toBe('block');
    expect(term.options.cursorBlink).toBe(false);
  });

  test('multiple sequences in one chunk — last one wins', () => {
    const term = makeTerm();
    applyDecscusr(term as never, '\x1b[2 q some output \x1b[5 q');
    expect(term.options.cursorStyle).toBe('bar');
    expect(term.options.cursorBlink).toBe(true);
  });

  test('sequence embedded in regular output', () => {
    const term = makeTerm();
    applyDecscusr(term as never, 'text before\x1b[6 qtext after');
    expect(term.options.cursorStyle).toBe('bar');
    expect(term.options.cursorBlink).toBe(false);
  });
});

describe('applyDecscusr — force repaint', () => {
  test('calls renderer.render with forceAll=true when style changes', () => {
    const term = makeTermWithRenderer();
    applyDecscusr(term as never, '\x1b[6 q');
    expect(term.renderer.render).toHaveBeenCalledTimes(1);
    expect(term.renderer.render).toHaveBeenCalledWith(term.wasmTerm, true, 0);
  });

  test('calls renderer.render when only blink changes', () => {
    const term = makeTermWithRenderer();
    term.options.cursorBlink = true;
    applyDecscusr(term as never, '\x1b[2 q');
    expect(term.renderer.render).toHaveBeenCalledTimes(1);
  });

  test('does not call renderer.render when style is unchanged', () => {
    const term = makeTermWithRenderer();
    term.options.cursorStyle = 'block';
    term.options.cursorBlink = false;
    applyDecscusr(term as never, '\x1b[2 q');
    expect(term.renderer.render).not.toHaveBeenCalled();
  });

  test('does not call renderer.render when no DECSCUSR sequence', () => {
    const term = makeTermWithRenderer();
    applyDecscusr(term as never, 'hello world');
    expect(term.renderer.render).not.toHaveBeenCalled();
  });

  test('calls renderer.render once even with multiple changing sequences', () => {
    const term = makeTermWithRenderer();
    applyDecscusr(term as never, '\x1b[2 q\x1b[6 q');
    expect(term.renderer.render).toHaveBeenCalledTimes(1);
  });

  test('does not call renderer.render when sequences cancel out to original values', () => {
    const term = makeTermWithRenderer();
    applyDecscusr(term as never, '\x1b[6 q\x1b[2 q');
    expect(term.renderer.render).not.toHaveBeenCalled();
  });
});
