import { describe, expect, test } from 'bun:test';
import {
  browserClipboardEnv,
  type ClipboardEnv,
  copyText,
  copyWithExecCommand,
  copyWithWriteText,
} from '../../ghostty-web/selection/clipboard-copy';
import { FakeTextarea } from '../support/selection-fixture';

// Each strategy of the copy chain and each fallback between them.

interface EnvOptions {
  /** Whether ClipboardItem exists, and whether constructing one throws. */
  item?: 'ok' | 'throws';
  write?: 'ok' | 'rejects';
  writeText?: 'ok' | 'rejects' | 'missing';
  noClipboard?: boolean;
  execCommand?: 'ok' | 'fails' | 'throws';
  /** Whether something has focus before the copy. */
  focused?: boolean;
}

/** An env whose every call is logged in order. */
function env(options: EnvOptions) {
  const log: string[] = [];
  const textarea = new FakeTextarea();
  const focused = { focus: () => void log.push('refocus') };
  class Item {
    constructor(readonly items: Record<string, Blob>) {
      if (options.item === 'throws') throw new Error('no items');
      log.push(`item ${Object.keys(items).join()}`);
    }
  }
  const settle = (outcome: string | undefined, name: string) =>
    outcome === 'rejects' ? Promise.reject(new Error(name)) : Promise.resolve();
  const clipboard: ClipboardEnv['clipboard'] = {
    write: () => {
      log.push('write');
      return settle(options.write, 'write');
    },
  };
  if (options.writeText !== 'missing') {
    clipboard.writeText = (text: string) => {
      log.push(`writeText ${text}`);
      return settle(options.writeText, 'writeText');
    };
  }
  const e: ClipboardEnv = {
    clipboard: options.noClipboard ? undefined : clipboard,
    ClipboardItem: options.item ? (Item as unknown as ClipboardEnv['ClipboardItem']) : undefined,
    document: {
      activeElement: options.focused ? (focused as unknown as Element) : null,
      execCommand: (command: string) => {
        log.push(`execCommand ${command} ${textarea.value}`);
        if (options.execCommand === 'throws') throw new Error('denied');
        return options.execCommand !== 'fails';
      },
    },
    textarea: textarea.element,
    warn: (message: unknown) => void log.push(`warn ${message}`),
  };
  return { env: e, log, textarea };
}

/** Lets rejected writes run their fallbacks. */
const settled = () => Bun.sleep(0);

describe('copyText', () => {
  test('writes a ClipboardItem when the browser has one', async () => {
    const { env: e, log } = env({ item: 'ok', writeText: 'ok' });
    copyText('hi', e);
    await settled();
    expect(log).toEqual(['item text/plain', 'write']);
  });

  test('falls back to writeText when the ClipboardItem write fails', async () => {
    const { env: e, log } = env({ item: 'ok', write: 'rejects', writeText: 'ok' });
    copyText('hi', e);
    await settled();
    expect(log).toEqual([
      'item text/plain',
      'write',
      'warn ClipboardItem write failed, trying writeText:',
      'writeText hi',
    ]);
  });

  test('falls back to execCommand when the ClipboardItem write fails and there is no writeText', async () => {
    const { env: e, log } = env({ item: 'ok', write: 'rejects', writeText: 'missing' });
    copyText('hi', e);
    await settled();
    expect(log.slice(-1)).toEqual(['execCommand copy hi']);
  });

  test('uses writeText when a ClipboardItem cannot be made', async () => {
    const { env: e, log } = env({ item: 'throws', writeText: 'ok' });
    copyText('hi', e);
    await settled();
    expect(log).toEqual(['writeText hi']);
  });

  test('uses writeText without ClipboardItem, then execCommand if it fails', async () => {
    const ok = env({ writeText: 'ok' });
    copyText('hi', ok.env);
    await settled();
    expect(ok.log).toEqual(['writeText hi']);
    const refused = env({ writeText: 'rejects' });
    copyText('hi', refused.env);
    await settled();
    expect(refused.log).toEqual([
      'writeText hi',
      'warn Clipboard writeText failed, trying execCommand:',
      'execCommand copy hi',
    ]);
  });

  test('uses execCommand without a clipboard', () => {
    const { env: e, log } = env({ noClipboard: true });
    copyText('hi', e);
    expect(log).toEqual(['execCommand copy hi']);
  });
});

describe('copyWithWriteText', () => {
  test('writes the text, or goes to execCommand without writeText', async () => {
    const ok = env({ writeText: 'ok' });
    copyWithWriteText('a', ok.env);
    await settled();
    expect(ok.log).toEqual(['writeText a']);
    const missing = env({ writeText: 'missing' });
    copyWithWriteText('a', missing.env);
    expect(missing.log).toEqual(['execCommand copy a']);
  });
});

describe('copyWithExecCommand', () => {
  test('copies from the textarea placed offscreen, selected, and gives focus back', () => {
    const { env: e, log, textarea } = env({ focused: true });
    copyWithExecCommand('text', e);
    expect(textarea.style).toEqual({
      position: 'fixed',
      left: '-9999px',
      top: '0',
      width: '1px',
      height: '1px',
      opacity: '0',
    });
    expect(textarea.calls).toEqual(['focus', 'select', 'range 0-4']);
    expect(log).toEqual(['execCommand copy text', 'refocus']);
  });

  test('warns when the copy fails or throws, still giving focus back', () => {
    const fails = env({ execCommand: 'fails', focused: true });
    copyWithExecCommand('x', fails.env);
    expect(fails.log).toEqual(['execCommand copy x', 'refocus', 'warn execCommand copy failed']);
    const throws = env({ execCommand: 'throws', focused: true });
    copyWithExecCommand('x', throws.env);
    expect(throws.log).toEqual(['execCommand copy x', 'warn execCommand copy threw:', 'refocus']);
  });

  test('gives focus to nothing when nothing had it', () => {
    const { env: e, log } = env({ execCommand: 'throws' });
    copyWithExecCommand('x', e);
    expect(log).not.toContain('refocus');
  });
});

describe('browserClipboardEnv', () => {
  test("reads the page's clipboard; Bun has no ClipboardItem", () => {
    const textarea = new FakeTextarea();
    const doc = { activeElement: null, execCommand: () => true };
    const e = browserClipboardEnv(textarea.element, doc);
    expect(e.clipboard).toBe(navigator.clipboard);
    expect(e.ClipboardItem).toBeUndefined();
    expect(e.document).toBe(doc);
    expect(e.textarea).toBe(textarea.element);
  });

  test('warns on the console', () => {
    const warn = console.warn;
    const seen: unknown[][] = [];
    console.warn = (...args: unknown[]) => void seen.push(args);
    try {
      browserClipboardEnv(new FakeTextarea().element, {
        activeElement: null,
        execCommand: () => true,
      }).warn('a', 1);
    } finally {
      console.warn = warn;
    }
    expect(seen).toEqual([['a', 1]]);
  });
});
