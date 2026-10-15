import { describe, expect, test } from 'bun:test';
import { ClipboardWriter } from './clipboard-writer';

function setup(clipboard: 'ok' | 'refuse' | 'none' = 'ok') {
  const written: string[] = [];
  const logs: string[] = [];
  const api =
    clipboard === 'none'
      ? undefined
      : {
          writeText: async (text: string) => {
            if (clipboard === 'refuse') throw new Error('Document is not focused.');
            written.push(text);
          },
        };
  const writer = new ClipboardWriter(api, (m) => logs.push(m));
  return { writer, written, logs };
}

describe('ClipboardWriter', () => {
  test('writes the text, UTF-8 and empty included, after user input', async () => {
    const { writer, written, logs } = setup();
    writer.connected();
    writer.userInput();
    await writer.write('héllo 中文 🎉');
    await writer.write('');
    expect(written).toEqual(['héllo 中文 🎉', '']);
    expect(logs).toEqual([]);
  });

  test('ignores writes from the replay, before any input since connecting', async () => {
    const { writer, written, logs } = setup();
    await writer.write('from the replay');
    writer.userInput();
    await writer.write('typed');
    // A reconnect replays again.
    writer.connected();
    await writer.write('replayed again');
    expect(written).toEqual(['typed']);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('before any input');
  });

  test('logs a refused write once, with no error thrown', async () => {
    const { writer, logs } = setup('refuse');
    writer.userInput();
    await writer.write('a');
    await writer.write('b');
    expect(logs).toEqual([
      'webtty: the browser refused an OSC 52 clipboard write: Document is not focused.',
    ]);
  });

  test('logs once when the page has no clipboard API', async () => {
    const { writer, logs } = setup('none');
    writer.userInput();
    await writer.write('a');
    await writer.write('b');
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('no clipboard API');
  });
});
