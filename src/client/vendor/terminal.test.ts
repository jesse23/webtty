import { describe, expect, test } from 'bun:test';
import { decscusrShape, mouseCursorFor, scanDecscusr } from './ghostty-web/terminal';
import type { ILink } from './ghostty-web/types';

describe('mouseCursorFor', () => {
  const link: ILink = {
    text: 'https://example.com',
    range: { start: { x: 0, y: 0 }, end: { x: 18, y: 0 } },
    activate: () => {},
  };

  test('uses the default arrow when no link is hovered', () => {
    expect(mouseCursorFor(undefined)).toBe('default');
  });

  test('uses the pointer over a link', () => {
    expect(mouseCursorFor(link)).toBe('pointer');
  });
});

describe('decscusrShape', () => {
  test('Ps 0 clears the app shape so the configured one shows', () => {
    expect(decscusrShape(0)).toBeUndefined();
  });

  test('Ps 1 — blinking block', () => {
    expect(decscusrShape(1)).toEqual({ style: 'block', blink: true });
  });

  test('Ps 2 — steady block', () => {
    expect(decscusrShape(2)).toEqual({ style: 'block', blink: false });
  });

  test('Ps 3 — blinking underline', () => {
    expect(decscusrShape(3)).toEqual({ style: 'underline', blink: true });
  });

  test('Ps 4 — steady underline', () => {
    expect(decscusrShape(4)).toEqual({ style: 'underline', blink: false });
  });

  test('Ps 5 — blinking bar', () => {
    expect(decscusrShape(5)).toEqual({ style: 'bar', blink: true });
  });

  test('Ps 6 — steady bar', () => {
    expect(decscusrShape(6)).toEqual({ style: 'bar', blink: false });
  });
});

describe('scanDecscusr', () => {
  test('reads Ps', () => {
    expect(scanDecscusr('\x1b[6 q')).toEqual({ ps: 6, carry: '' });
  });

  test('empty Ps is 0', () => {
    expect(scanDecscusr('\x1b[ q').ps).toBe(0);
  });

  test('no sequence yields no Ps', () => {
    expect(scanDecscusr('hello world')).toEqual({ ps: undefined, carry: '' });
  });

  test('out-of-range Ps is ignored', () => {
    expect(scanDecscusr('\x1b[7 q').ps).toBeUndefined();
    expect(scanDecscusr('\x1b[5 q\x1b[7 q').ps).toBe(5);
  });

  test('last sequence in a chunk wins', () => {
    expect(scanDecscusr('\x1b[2 q some output \x1b[5 q').ps).toBe(5);
  });

  test('finds a sequence embedded in output', () => {
    expect(scanDecscusr('text before\x1b[6 qtext after').ps).toBe(6);
  });

  test('ignores other CSI sequences ending in q', () => {
    expect(scanDecscusr('\x1b[>q\x1b[1q\x1b[0"q').ps).toBeUndefined();
  });

  test('carries a sequence split across chunks', () => {
    for (const [head, tail] of [
      ['ab\x1b', '[6 q'],
      ['ab\x1b[', '6 q'],
      ['ab\x1b[6', ' q'],
      ['ab\x1b[6 ', 'q'],
    ]) {
      const first = scanDecscusr(head);
      expect(first.ps).toBeUndefined();
      expect(first.carry).toBe(head.slice(2));
      expect(scanDecscusr(tail, first.carry)).toEqual({ ps: 6, carry: '' });
    }
  });

  test('carries nothing after a finished sequence or plain text', () => {
    expect(scanDecscusr('\x1b[6 q').carry).toBe('');
    expect(scanDecscusr('\x1b[6m').carry).toBe('');
    expect(scanDecscusr('\x1b[6 x').carry).toBe('');
  });
});
