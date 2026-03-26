import { describe, expect, test } from 'bun:test';
import { applyDecscusr } from './cursor';

function makeTerm(): { options: { cursorStyle: string; cursorBlink: boolean } } {
  return { options: { cursorStyle: 'block', cursorBlink: false } };
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
