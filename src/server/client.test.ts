import { describe, expect, test } from 'bun:test';
import { DEFAULT_CONFIG } from '../config';
import { render } from './client';

describe('clientShell', () => {
  test('returns valid HTML document', () => {
    const html = render('my-session', DEFAULT_CONFIG);
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('<html');
    expect(html).toContain('</html>');
  });

  test('injects session id into title', () => {
    const html = render('my-session', DEFAULT_CONFIG);
    expect(html).toContain('webtty — my-session');
  });

  test('injects session id as JS string literal', () => {
    const html = render('my-session', DEFAULT_CONFIG);
    expect(html).toContain('"my-session"');
  });

  test('JS string literal uses JSON.stringify so special chars are escaped', () => {
    const html = render('my"session', DEFAULT_CONFIG);
    expect(html).toContain('"my\\"session"');
  });

  test('ws path uses session id', () => {
    const html = render('my-session', DEFAULT_CONFIG);
    expect(html).toContain('/ws/');
  });

  test('injects fontSize into terminal options', () => {
    const html = render('s', { ...DEFAULT_CONFIG, fontSize: 20 });
    expect(html).toContain('fontSize: 20');
  });

  test('injects fontFamily into terminal options', () => {
    const html = render('s', { ...DEFAULT_CONFIG, fontFamily: 'Menlo' });
    expect(html).toContain('fontFamily: "Menlo"');
  });

  test('injects cols and rows into terminal options', () => {
    const html = render('s', { ...DEFAULT_CONFIG, cols: 120, rows: 40 });
    expect(html).toContain('cols: 120');
    expect(html).toContain('rows: 40');
  });

  test('injects cursorBlink into terminal options', () => {
    const html = render('s', { ...DEFAULT_CONFIG, cursorBlink: false });
    expect(html).toContain('cursorBlink: false');
  });

  test('injects scrollback as line count derived from bytes', () => {
    const html = render('s', { ...DEFAULT_CONFIG, scrollback: 8000 });
    expect(html).toContain(`scrollback: ${Math.ceil(8000 / 80)}`);
  });

  test('injects theme background color into CSS', () => {
    const html = render('s', {
      ...DEFAULT_CONFIG,
      theme: { ...DEFAULT_CONFIG.theme, background: '#FF0000' },
    });
    expect(html).toContain('#FF0000');
  });

  test('injects full theme object into terminal options', () => {
    const html = render('s', {
      ...DEFAULT_CONFIG,
      theme: { ...DEFAULT_CONFIG.theme, foreground: '#AABBCC' },
    });
    expect(html).toContain('"foreground"');
    expect(html).toContain('#AABBCC');
  });
});
