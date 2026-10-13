import { describe, expect, test } from 'bun:test';
import { mouseCursorFor } from './ghostty-web/terminal';
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
