import { describe, expect, test } from 'bun:test';
import { sessionBanner } from './session-banner';

// The exact bytes the server wrote before the banner moved here; a change to them is a
// change to what every new session prints first.
const BUNX =
  '\u001b[1;36m╔════════════════════════════════════════════════╗\u001b[0m\r\n\u001b[1;36m║\u001b[0m                                                \u001b[1;36m║\u001b[0m\r\n\u001b[1;36m║\u001b[0m \u001b[2m[\u001b[0m \u001b[1m\u001b[1;33mwebtty\u001b[0m \u001b[2m]   Terminal UI in the browser\u001b[0m        \u001b[1;36m║\u001b[0m\r\n\u001b[1;36m║\u001b[0m                                                \u001b[1;36m║\u001b[0m\r\n\u001b[1;36m║\u001b[0m \u001b[2mRun `\u001b[0m\u001b[3mbunx webtty help\u001b[0m\u001b[2m` for more information.\u001b[0m   \u001b[1;36m║\u001b[0m\r\n\u001b[1;36m║\u001b[0m                                                \u001b[1;36m║\u001b[0m\r\n\u001b[1;36m╚════════════════════════════════════════════════╝\u001b[0m\r\n\r\n';
const NPX =
  '\u001b[1;36m╔════════════════════════════════════════════════╗\u001b[0m\r\n\u001b[1;36m║\u001b[0m                                                \u001b[1;36m║\u001b[0m\r\n\u001b[1;36m║\u001b[0m \u001b[2m[\u001b[0m \u001b[1m\u001b[1;33mwebtty\u001b[0m \u001b[2m]   Terminal UI in the browser\u001b[0m        \u001b[1;36m║\u001b[0m\r\n\u001b[1;36m║\u001b[0m                                                \u001b[1;36m║\u001b[0m\r\n\u001b[1;36m║\u001b[0m \u001b[2mRun `\u001b[0m\u001b[3mnpx webtty help\u001b[0m\u001b[2m` for more information.\u001b[0m    \u001b[1;36m║\u001b[0m\r\n\u001b[1;36m║\u001b[0m                                                \u001b[1;36m║\u001b[0m\r\n\u001b[1;36m╚════════════════════════════════════════════════╝\u001b[0m\r\n\r\n';

// biome-ignore lint/suspicious/noControlCharactersInRegex: ESC (\x1b) starts the SGR sequences being stripped
const visible = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, '');

describe('sessionBanner', () => {
  test.each([
    ['bunx', BUNX],
    ['npx', NPX],
  ])('pins the %s banner byte for byte', (runner, expected) => {
    expect(sessionBanner(runner)).toBe(expected);
  });

  test.each(['bunx', 'npx'])('every %s line is 50 columns wide, borders included', (runner) => {
    const lines = sessionBanner(runner).split('\r\n');
    expect(lines.slice(-2)).toEqual(['', '']);
    const boxed = lines.slice(0, -2);
    expect(boxed).toHaveLength(7);
    for (const line of boxed) expect(visible(line)).toHaveLength(50);
  });

  test('names the runner in the help hint', () => {
    expect(visible(sessionBanner('npx'))).toContain(' Run `npx webtty help` for more information.');
    expect(visible(sessionBanner('bunx'))).toContain(
      ' Run `bunx webtty help` for more information.',
    );
  });
});
