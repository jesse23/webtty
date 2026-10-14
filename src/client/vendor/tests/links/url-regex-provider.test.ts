import { describe, expect, test } from 'bun:test';
import type { ILink } from '../../ghostty-web/link-types';
import { UrlRegexProvider } from '../../ghostty-web/providers/url-regex-provider';

// UrlRegexProvider on a fake buffer of text rows: the schemes it knows, the punctuation
// it drops, the minimum length, the regex state between rows, and activation.

/** The code points of `text`. */
const codePoints = (text: string) => [...text].map((c) => c.codePointAt(0) ?? 0);

/** A buffer whose rows are `lines`; a code point of -1 is a missing cell. */
function buffer(lines: (string | number[])[]) {
  return {
    buffer: {
      active: {
        getLine: (y: number) => {
          const line = lines[y];
          if (line === undefined) return undefined;
          const points = typeof line === 'string' ? codePoints(line) : line;
          return {
            length: points.length,
            getCell: (x: number) =>
              points[x] === -1 ? undefined : { getCodepoint: () => points[x] },
          };
        },
      },
    },
  };
}

/** The links found on row `y` of `lines`, and what activating them opened. */
function linksOn(lines: (string | number[])[], y = 0) {
  const opened: string[][] = [];
  const provider = new UrlRegexProvider(buffer(lines), (url, target, features) =>
    opened.push([url, target, features]),
  );
  let found: ILink[] | undefined;
  provider.provideLinks(y, (links) => {
    found = links;
  });
  return { found, opened, provider };
}

const texts = (lines: string[], y = 0) => linksOn(lines, y).found?.map((link) => link.text);

describe('UrlRegexProvider', () => {
  test.each([
    'https://example.com/a?b=c#d',
    'http://example.com',
    'mailto:me@example.com',
    'ftp://files.example.com',
    'ssh://host.example.com',
    'git://host.example.com/r',
    'tel:+15551234567',
    'magnet:?xt=urn:btih:abc',
    'gemini://capsule.example',
    'gopher://hole.example',
    'news:comp.lang.c',
  ])('finds %s', (url) => {
    expect(texts([`see ${url} here`])).toEqual([url]);
  });

  test('ignores file paths and unknown schemes', () => {
    expect(texts(['./a/b ../c /usr/bin file://x/y javascript:alert(1)'])).toBeUndefined();
  });

  test.each([
    ['(https://example.com/x).', 'https://example.com/x'],
    ['https://example.com/x, next', 'https://example.com/x'],
    ['https://example.com/x!?;', 'https://example.com/x'],
    ['[https://example.com/x]', 'https://example.com/x'],
  ])('drops the trailing punctuation of %p', (line, url) => {
    expect(texts([line])).toEqual([url]);
  });

  test('skips a URL of 8 characters or fewer, as a bare scheme', () => {
    expect(texts(['http://a https://'])).toBeUndefined();
    expect(texts(['http://ab'])).toEqual(['http://ab']);
  });

  test('ranges cover the URL on its row, without the dropped punctuation', () => {
    const { found } = linksOn(['', 'go https://x.io/p. then http://y.io'], 1);
    expect(found?.map((link) => link.range)).toEqual([
      { start: { x: 3, y: 1 }, end: { x: 16, y: 1 } },
      { start: { x: 24, y: 1 }, end: { x: 34, y: 1 } },
    ]);
  });

  test('every row is scanned from its start, whatever the last scan left in the regex', () => {
    const lines = ['https://first.example/long/path https://b.example', 'https://c.example'];
    const { provider } = linksOn(lines);
    const seen: (string[] | undefined)[] = [];
    for (const y of [0, 1, 1]) {
      provider.provideLinks(y, (links) => seen.push(links?.map((link) => link.text)));
    }
    expect(seen).toEqual([
      ['https://first.example/long/path', 'https://b.example'],
      ['https://c.example'],
      ['https://c.example'],
    ]);
  });

  test('control characters and missing cells break a URL like spaces', () => {
    const points = codePoints('https://a.example');
    const withNul = [...points, 0, ...points];
    expect(linksOn([withNul]).found?.map((link) => link.range.end.x)).toEqual([16, 34]);
    const withGap = [...points, -1, 7, ...points];
    expect(linksOn([withGap]).found).toHaveLength(2);
  });

  test('a missing row has no links', () => {
    expect(linksOn([], 3).found).toBeUndefined();
  });

  test('activating a link opens it in a new tab only with Ctrl or Cmd held', () => {
    const { found, opened, provider } = linksOn(['https://example.com']);
    const [link] = found ?? [];
    link.activate({ ctrlKey: false, metaKey: false } as MouseEvent);
    expect(opened).toEqual([]);
    link.activate({ ctrlKey: true, metaKey: false } as MouseEvent);
    link.activate({ ctrlKey: false, metaKey: true } as MouseEvent);
    expect(opened).toEqual([
      ['https://example.com', '_blank', 'noopener,noreferrer'],
      ['https://example.com', '_blank', 'noopener,noreferrer'],
    ]);
    provider.dispose();
  });
});
