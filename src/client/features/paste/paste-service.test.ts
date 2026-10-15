import { describe, expect, test } from 'bun:test';
import { type ClipboardSource, PasteService } from './paste-service';

/** A service on logging fakes; the socket is open and the clipboard holds `clip` unless told. */
function setup(opts: { open?: boolean; navigator?: ClipboardSource } = {}) {
  const log: string[] = [];
  let open = opts.open ?? true;
  const service = new PasteService(
    {
      paste: (text) => log.push(`paste:${text}`),
      scrollToBottom: () => log.push('scrollToBottom'),
    },
    { isOpen: () => open, send: (data) => log.push(`send:${JSON.stringify(data)}`) },
    opts.navigator ?? { clipboard: { readText: async () => 'clip' } },
  );
  return { log, service, close: () => (open = false) };
}

/** Lets a clipboard read's promise and its handler run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('PasteService.paste', () => {
  test('text goes through the terminal, which encodes it (ADR 049)', () => {
    const { log, service } = setup();
    service.paste('one\ntwo');
    expect(log).toEqual(['paste:one\ntwo']);
  });

  test('a non-text paste (empty text) scrolls to the bottom and sends Ctrl+V (ADR 037)', () => {
    const { log, service } = setup();
    service.paste('');
    expect(log).toEqual(['scrollToBottom', 'send:"\\u0016"']);
  });

  test.each(['text', ''])('a closed socket sends nothing (%p)', (text) => {
    const { log, service } = setup({ open: false });
    service.paste(text);
    expect(log).toEqual([]);
  });
});

describe('PasteService.pasteFromClipboard', () => {
  test('reads the clipboard and pastes its text', async () => {
    const { log, service } = setup();
    expect(service.pasteFromClipboard()).toBe(true);
    await settle();
    expect(log).toEqual(['paste:clip']);
  });

  test('a failed read sends Ctrl+V, as Cmd+V would reach the app (ADR 014)', async () => {
    const { log, service } = setup({
      navigator: { clipboard: { readText: () => Promise.reject(new Error('denied')) } },
    });
    expect(service.pasteFromClipboard()).toBe(true);
    await settle();
    expect(log).toEqual(['scrollToBottom', 'send:"\\u0016"']);
  });

  test('a failed read after the socket closed sends nothing', async () => {
    const { log, service, close } = setup({
      navigator: { clipboard: { readText: () => Promise.reject(new Error('denied')) } },
    });
    service.pasteFromClipboard();
    close();
    await settle();
    expect(log).toEqual([]);
  });

  test('a read that lands after the socket closed sends nothing', async () => {
    const { log, service, close } = setup();
    service.pasteFromClipboard();
    close();
    await settle();
    expect(log).toEqual([]);
  });

  test.each<[string, ClipboardSource]>([
    ['no clipboard API (http)', {}],
    ['a clipboard without readText', { clipboard: {} as Pick<Clipboard, 'readText'> }],
  ])('returns false with %s and reads nothing', (_name, navigator) => {
    const { log, service } = setup({ navigator });
    expect(service.pasteFromClipboard()).toBe(false);
    expect(log).toEqual([]);
  });

  test('reads navigator.clipboard at each paste, not once', async () => {
    const navigator: { clipboard?: Pick<Clipboard, 'readText'> } = {};
    const { log, service } = setup({ navigator });
    expect(service.pasteFromClipboard()).toBe(false);
    navigator.clipboard = { readText: async () => 'later' };
    expect(service.pasteFromClipboard()).toBe(true);
    await settle();
    expect(log).toEqual(['paste:later']);
  });
});
