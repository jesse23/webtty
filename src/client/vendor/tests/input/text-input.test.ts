import { afterEach, describe, expect, test } from 'bun:test';
import { createDomWindow, type DomWindow } from '../../../test-support/dom-window';
import { ManualClock } from '../../../test-support/manual-clock';
import {
  beforeInputText,
  defaultNow,
  ECHO_WINDOW_MS,
  EchoGuard,
  removeCompositionText,
} from '../../ghostty-web/input/text-input';

// IME and mobile-keyboard text: the beforeinput text, the echo guard's 100 ms windows and
// the composition text-node cleanup (ADR 061).

describe('beforeInputText', () => {
  test.each([
    ['insertText', 'abc', 'abc'],
    ['insertText', 'a\nb\n', 'a\rb\r'],
    ['insertReplacementText', 'word', 'word'],
    ['insertText', '', null],
    ['insertReplacementText', '', null],
    ['insertLineBreak', '', '\r'],
    ['insertParagraph', 'ignored', '\r'],
    ['deleteContentBackward', '', '\x7F'],
    ['deleteContentForward', '', '\x1B[3~'],
    // Paste is webtty's capture listener's (ADR 037)
    ['insertFromPaste', 'a\nb', null],
    ['insertCompositionText', 'あ', null],
    ['deleteWordBackward', '', null],
  ])('%s %p sends %p', (inputType, data, expected) => {
    expect(beforeInputText(inputType, data)).toBe(expected);
  });
});

describe('EchoGuard', () => {
  test('the window is 100 ms', () => {
    expect(ECHO_WINDOW_MS).toBe(100);
  });

  test('a beforeinput within 100 ms of the same keydown text is an echo', () => {
    const clock = new ManualClock();
    const guard = new EchoGuard(clock.now);
    guard.recordKeyDown('a');
    clock.advance(99);
    expect(guard.isKeyDownEcho('a')).toBe(true);
    // The keydown is forgotten once checked
    expect(guard.isKeyDownEcho('a')).toBe(false);
  });

  test('a keydown is forgotten after one check, even when the text differs', () => {
    const guard = new EchoGuard(new ManualClock().now);
    guard.recordKeyDown('a');
    expect(guard.isKeyDownEcho('b')).toBe(false);
    expect(guard.isKeyDownEcho('a')).toBe(false);
  });

  test('at 100 ms the same text is new input', () => {
    const clock = new ManualClock();
    const guard = new EchoGuard(clock.now);
    guard.recordKeyDown('a');
    clock.advance(ECHO_WINDOW_MS);
    expect(guard.isKeyDownEcho('a')).toBe(false);
  });

  test('a composition is remembered until a beforeinput repeats it', () => {
    const clock = new ManualClock();
    const guard = new EchoGuard(clock.now);
    expect(guard.isCompositionEcho('日本')).toBe(false);
    guard.recordComposition('日本');
    expect(guard.isCompositionEcho('日')).toBe(false);
    clock.advance(50);
    expect(guard.isCompositionEcho('日本')).toBe(true);
    expect(guard.isCompositionEcho('日本')).toBe(false);
  });

  test('a composition is not an echo source once 100 ms have passed', () => {
    const clock = new ManualClock();
    const guard = new EchoGuard(clock.now);
    guard.recordComposition('日本');
    clock.advance(100);
    expect(guard.isCompositionEcho('日本')).toBe(false);
  });

  test('a beforeinput is remembered until a composition end repeats it', () => {
    const clock = new ManualClock();
    const guard = new EchoGuard(clock.now);
    expect(guard.isBeforeInputEcho('x')).toBe(false);
    guard.recordBeforeInput('x');
    expect(guard.isBeforeInputEcho('y')).toBe(false);
    clock.advance(99);
    expect(guard.isBeforeInputEcho('x')).toBe(true);
    expect(guard.isBeforeInputEcho('x')).toBe(false);
    guard.recordBeforeInput('x');
    clock.advance(100);
    expect(guard.isBeforeInputEcho('x')).toBe(false);
  });

  test('the three paths are kept apart', () => {
    const guard = new EchoGuard(new ManualClock().now);
    guard.recordKeyDown('a');
    expect(guard.isCompositionEcho('a')).toBe(false);
    expect(guard.isBeforeInputEcho('a')).toBe(false);
    guard.recordComposition('b');
    guard.recordBeforeInput('c');
    expect(guard.isKeyDownEcho('b')).toBe(false);
    expect(guard.isCompositionEcho('b')).toBe(true);
    expect(guard.isBeforeInputEcho('c')).toBe(true);
  });

  test('the default clock is performance.now, else Date.now', () => {
    const before = performance.now();
    expect(defaultNow()).toBeGreaterThanOrEqual(before);
    const saved = globalThis.performance;
    try {
      Object.defineProperty(globalThis, 'performance', { value: undefined, configurable: true });
      const wall = Date.now();
      expect(defaultNow()).toBeGreaterThanOrEqual(wall);
    } finally {
      Object.defineProperty(globalThis, 'performance', { value: saved, configurable: true });
    }
    expect(new EchoGuard().isKeyDownEcho('a')).toBe(false);
  });
});

describe('removeCompositionText', () => {
  let dom: DomWindow;
  afterEach(() => dom.close());

  test('removes the text nodes and keeps the elements', () => {
    dom = createDomWindow();
    const container = dom.document.createElement('div');
    const canvas = dom.document.createElement('canvas');
    container.append('日', canvas, '本', '語');
    removeCompositionText(container);
    expect([...container.childNodes]).toEqual([canvas]);
  });

  test('leaves an empty container alone', () => {
    dom = createDomWindow();
    const container = dom.document.createElement('div');
    removeCompositionText(container);
    expect(container.childNodes.length).toBe(0);
  });
});
