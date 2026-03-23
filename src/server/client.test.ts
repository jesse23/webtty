import { describe, expect, test } from 'bun:test';
import { render } from './client';

describe('clientShell', () => {
  test('returns valid HTML document', () => {
    const html = render('my-session');
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('<html');
    expect(html).toContain('</html>');
  });

  test('injects session id into title', () => {
    const html = render('my-session');
    expect(html).toContain('webtty — my-session');
  });

  test('injects session id as JS string literal', () => {
    const html = render('my-session');
    expect(html).toContain('"my-session"');
  });

  test('JS string literal uses JSON.stringify so special chars are escaped', () => {
    const html = render('my"session');
    expect(html).toContain('"my\\"session"');
  });

  test('ws path uses session id', () => {
    const html = render('my-session');
    expect(html).toContain('/ws/');
  });
});
