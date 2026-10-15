import { describe, expect, test } from 'bun:test';
import { statusLine } from './status-line';

describe('statusLine', () => {
  test('a dim "[ webtty ]" tag and dim italic text on a line of their own', () => {
    expect(statusLine('Server stopped.')).toBe(
      '\r\n\x1b[2m[\x1b[0m \x1b[1;33mwebtty\x1b[0m \x1b[2m]\x1b[0m \x1b[2m\x1b[3mServer stopped.\x1b[0m\r\n',
    );
  });
});
