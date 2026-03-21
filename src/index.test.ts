import { expect, test } from 'bun:test';
import { greet } from './index';

test('greet returns expected string', () => {
  expect(greet('world')).toBe('wtty: hello, world');
});
