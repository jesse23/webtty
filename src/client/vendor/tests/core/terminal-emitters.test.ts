import { describe, expect, test } from 'bun:test';
import { TerminalEmitters } from '../../ghostty-web/core/terminal-emitters';

// Terminal's emitters, one per onX event, disposed together.

const NAMES = [
  'data',
  'resize',
  'bell',
  'titleChange',
  'scroll',
  'pasteRequest',
  'clipboardWrite',
  'desktopNotification',
  'findChange',
] as const;

describe('TerminalEmitters', () => {
  test('each emitter calls its own listeners', () => {
    const emit = new TerminalEmitters();
    const heard: string[] = [];
    for (const name of NAMES) emit[name].event(() => heard.push(name));
    emit.bell.fire();
    emit.data.fire('x');
    expect(heard).toEqual(['bell', 'data']);
  });

  test('dispose() drops every listener of every emitter; again does nothing', () => {
    const emit = new TerminalEmitters();
    const heard: string[] = [];
    for (const name of NAMES) emit[name].event(() => heard.push(name));
    emit.dispose();
    emit.dispose();
    for (const name of NAMES) (emit[name].fire as (arg?: unknown) => void)();
    expect(heard).toEqual([]);
  });
});
