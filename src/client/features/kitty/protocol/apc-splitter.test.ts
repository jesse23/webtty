import { describe, expect, test } from 'bun:test';
import { ApcSplitter } from './apc-splitter';

const ESC = '\x1b';
const apc = (body: string): string => `${ESC}_${body}${ESC}\\`;

describe('ApcSplitter', () => {
  test('plain text passes through untouched', () => {
    expect(new ApcSplitter().feed('hello \x1b[31mred\x1b[0m')).toEqual([
      { type: 'text', text: 'hello \x1b[31mred\x1b[0m' },
    ]);
  });

  test('splits text, APC, text in order', () => {
    const out = new ApcSplitter().feed(`before${apc('Ga=q;AAAA')}after`);
    expect(out).toEqual([
      { type: 'text', text: 'before' },
      { type: 'apc', body: 'Ga=q;AAAA' },
      { type: 'text', text: 'after' },
    ]);
  });

  test('multiple APCs in one chunk', () => {
    const out = new ApcSplitter().feed(`${apc('Ga=d')}x${apc('Ga=d,d=A')}`);
    expect(out.map((s) => s.type)).toEqual(['apc', 'text', 'apc']);
  });

  test('APC split across chunks at every byte boundary', () => {
    const full = `pre${apc('Gi=1,a=T;QUJD')}post`;
    for (let cut = 1; cut < full.length; cut++) {
      const s = new ApcSplitter();
      const segs = [...s.feed(full.slice(0, cut)), ...s.feed(full.slice(cut))];
      const text = segs
        .filter((x) => x.type === 'text')
        .map((x) => (x as { text: string }).text)
        .join('');
      const apcs = segs.filter((x) => x.type === 'apc');
      expect(text).toBe('prepost');
      expect(apcs).toEqual([{ type: 'apc', body: 'Gi=1,a=T;QUJD' }]);
    }
  });

  test('a trailing lone ESC is held until the next chunk decides what it is', () => {
    const s = new ApcSplitter();
    expect(s.feed('abc\x1b')).toEqual([{ type: 'text', text: 'abc' }]);
    expect(s.feed('[31m')).toEqual([{ type: 'text', text: '\x1b[31m' }]);
  });

  test('ESC not followed by _ is returned to the text stream', () => {
    expect(new ApcSplitter().feed('a\x1b[Hb\x1bcc')).toEqual([
      { type: 'text', text: 'a\x1b[Hb\x1bcc' },
    ]);
  });

  test('malformed APC (ESC not followed by backslash) is dropped and the ESC restarts a sequence', () => {
    const out = new ApcSplitter().feed('\x1b_Gjunk\x1b[31mred');
    expect(out).toEqual([{ type: 'text', text: '\x1b[31mred' }]);
  });

  test('non-graphics APC is still swallowed', () => {
    const out = new ApcSplitter().feed(`a${apc('Xsomething')}b`);
    expect(out[1]).toEqual({ type: 'apc', body: 'Xsomething' });
  });

  test('splitter is reusable after an APC completes', () => {
    const s = new ApcSplitter();
    s.feed(apc('Ga=d'));
    expect(s.feed('plain')).toEqual([{ type: 'text', text: 'plain' }]);
  });
});

describe('ApcSplitter size limit', () => {
  const big = (n: number) => 'A'.repeat(n);

  test('an oversized sequence is reported with its start, so it can still be answered', () => {
    const out = new ApcSplitter(20).feed(`before${apc(`Ga=t,i=1;${big(50)}`)}after`);
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({ type: 'text', text: 'before' });
    expect(out[1]).toMatchObject({ type: 'apc', overflow: true });
    expect((out[1] as { body: string }).body.startsWith('Ga=t,i=1;')).toBe(true);
    expect(out[2]).toEqual({ type: 'text', text: 'after' });
  });

  test('none of the payload reaches the text', () => {
    const out = new ApcSplitter(20).feed(apc(`Ga=t,i=1;${big(500)}`));
    expect(out.filter((s) => s.type === 'text')).toEqual([]);
  });

  test('only the start is kept, however large the sequence', () => {
    const out = new ApcSplitter(20).feed(apc(`Ga=t,i=1;${big(20000)}`));
    expect((out[0] as { body: string }).body.length).toBe(4096);
  });

  test('a sequence that is too big is still recognised across chunks', () => {
    const s = new ApcSplitter(20);
    expect(s.feed(`${ESC}_Ga=t,i=1;${big(30)}`)).toEqual([]);
    expect(s.feed(big(30))).toEqual([]);
    const out = s.feed(`${big(5)}${ESC}\\ok`);
    expect(out[0]).toMatchObject({ type: 'apc', overflow: true });
    expect(out[1]).toEqual({ type: 'text', text: 'ok' });
  });

  test('a sequence at the limit is delivered whole', () => {
    const body = `Ga=t;${big(15)}`;
    expect(new ApcSplitter(body.length).feed(apc(body))).toEqual([{ type: 'apc', body }]);
  });

  test.each([
    ['CAN', '\x18'],
    ['SUB', '\x1a'],
  ])('%s cancels a sequence that was never terminated, so text resumes', (_name, stop) => {
    const s = new ApcSplitter(20);
    expect(s.feed(`${ESC}_Ga=t;${big(100)}`)).toEqual([]);
    expect(s.feed(`still payload${stop}text again`)).toEqual([
      { type: 'text', text: 'text again' },
    ]);
  });

  test('CAN cancels an ordinary sequence too, delivering nothing', () => {
    const s = new ApcSplitter();
    expect(s.feed(`${ESC}_Ga=q;AA\x18after`)).toEqual([{ type: 'text', text: 'after' }]);
  });

  test('CAN in plain text is just text', () => {
    expect(new ApcSplitter().feed('a\x18b')).toEqual([{ type: 'text', text: 'a\x18b' }]);
  });
});
