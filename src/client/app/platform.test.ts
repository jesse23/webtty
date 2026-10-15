import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createDomWindow, type DomWindow } from '../test-support/dom-window';
import { detectMac, isMacPlatform, isTerminalFocused } from './platform';

describe('isMacPlatform', () => {
  test.each([
    ['macOS', true],
    ['MacIntel', true],
    ['iPhone', true],
    ['iPad', true],
    ['iPod touch', true],
    ['Windows', false],
    ['Win32', false],
    ['Linux x86_64', false],
    ['Chrome OS', false],
    ['', false],
  ])('%p takes the macOS defaults: %p', (platform, mac) => {
    expect(isMacPlatform(platform)).toBe(mac);
  });
});

describe('detectMac', () => {
  test.each([
    [{ platform: 'MacIntel' }, true],
    [{ platform: 'iPad' }, true],
    [{ platform: 'Win32' }, false],
    [{ platform: 'Linux x86_64' }, false],
    // Client Hints win over the legacy field when the browser has them
    [{ platform: 'MacIntel', userAgentData: { platform: 'Windows' } }, false],
    [{ platform: 'Win32', userAgentData: { platform: 'macOS' } }, true],
    // An empty Client Hints platform falls back to the legacy field
    [{ platform: 'MacIntel', userAgentData: { platform: '' } }, true],
  ])('%o is mac: %p', (navigator, mac) => {
    expect(detectMac(navigator)).toBe(mac);
  });
});

describe('isTerminalFocused', () => {
  let dom: DomWindow;
  let container: HTMLElement;
  let inside: HTMLTextAreaElement;
  let outside: HTMLInputElement;

  beforeEach(() => {
    dom = createDomWindow();
    const { document } = dom;
    container = document.createElement('div');
    inside = document.createElement('textarea');
    outside = document.createElement('input');
    container.append(inside);
    document.body.append(container, outside);
  });
  afterEach(() => dom.close());

  /** The document with its window focus and tab visibility set by the test. */
  function doc(hasFocus: boolean, visibilityState: DocumentVisibilityState = 'visible') {
    const { document } = dom;
    return {
      visibilityState,
      hasFocus: () => hasFocus,
      get activeElement() {
        return document.activeElement;
      },
    };
  }

  test('focus inside the container, the window focused and the tab shown', () => {
    inside.focus();
    expect(isTerminalFocused(doc(true), container)).toBe(true);
  });

  test('focus outside the container', () => {
    outside.focus();
    expect(isTerminalFocused(doc(true), container)).toBe(false);
  });

  test('the window not focused', () => {
    inside.focus();
    expect(isTerminalFocused(doc(false), container)).toBe(false);
  });

  test('the tab hidden', () => {
    inside.focus();
    expect(isTerminalFocused(doc(true, 'hidden'), container)).toBe(false);
  });
});
