import { describe, expect, test } from 'bun:test';
import { toTerminalTheme } from './theme';

describe('toTerminalTheme', () => {
  test('maps purple and brightPurple onto ghostty-web magenta names', () => {
    const t = toTerminalTheme({ purple: '#ab9df2', brightPurple: '#cdbdf9' });
    expect(t.magenta).toBe('#ab9df2');
    expect(t.brightMagenta).toBe('#cdbdf9');
    expect('purple' in t).toBe(false);
    expect('brightPurple' in t).toBe(false);
  });

  test('maps selection onto selectionBackground', () => {
    const t = toTerminalTheme({ selection: '#532d3d', selectionForeground: '#e0e0e0' });
    expect(t.selectionBackground).toBe('#532d3d');
    expect(t.selectionForeground).toBe('#e0e0e0');
    expect('selection' in t).toBe(false);
  });

  test('selected text takes the background colour when no selection foreground is given', () => {
    const t = toTerminalTheme({ selection: '#ffffff', background: '#000000' });
    expect(t.selectionForeground).toBe('#000000');
  });

  test('leaves ghostty-web selection defaults alone when there is no selection colour', () => {
    const t = toTerminalTheme({ background: '#000000' });
    expect('selectionBackground' in t).toBe(false);
    expect('selectionForeground' in t).toBe(false);
  });

  test('keeps padding out of the terminal theme and passes other keys through', () => {
    const t = toTerminalTheme({
      padding: '#101010',
      background: '#1f2021',
      foreground: '#e0e0e0',
      red: '#ff6188',
    });
    expect('padding' in t).toBe(false);
    expect(t.background).toBe('#1f2021');
    expect(t.foreground).toBe('#e0e0e0');
    expect(t.red).toBe('#ff6188');
  });

  test('never emits undefined values', () => {
    for (const value of Object.values(
      toTerminalTheme({ purple: undefined, selection: undefined }),
    )) {
      expect(value).toBeDefined();
    }
  });
});
