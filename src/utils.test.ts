import { describe, expect, test } from 'bun:test';
import { ghosttyWebRootFromMain, mimeType } from './utils';

describe('mimeType', () => {
  test('returns correct type for known extensions', () => {
    expect(mimeType('index.html')).toBe('text/html');
    expect(mimeType('app.js')).toBe('application/javascript');
    expect(mimeType('app.mjs')).toBe('application/javascript');
    expect(mimeType('style.css')).toBe('text/css');
    expect(mimeType('data.json')).toBe('application/json');
    expect(mimeType('module.wasm')).toBe('application/wasm');
    expect(mimeType('image.png')).toBe('image/png');
    expect(mimeType('icon.svg')).toBe('image/svg+xml');
    expect(mimeType('favicon.ico')).toBe('image/x-icon');
  });

  test('returns octet-stream for unknown extensions', () => {
    expect(mimeType('file.xyz')).toBe('application/octet-stream');
    expect(mimeType('binary.bin')).toBe('application/octet-stream');
  });

  test('works with full paths', () => {
    expect(mimeType('/dist/ghostty-web.js')).toBe('application/javascript');
    expect(mimeType('/dist/ghostty-vt.wasm')).toBe('application/wasm');
  });
});

describe('ghosttyWebRootFromMain', () => {
  test('strips dist/ and filename on posix path', () => {
    expect(ghosttyWebRootFromMain('/node_modules/ghostty-web/dist/index.js')).toBe(
      '/node_modules/ghostty-web',
    );
  });

  test('strips nested dist/ path', () => {
    expect(ghosttyWebRootFromMain('/node_modules/ghostty-web/dist/ghostty-web.js')).toBe(
      '/node_modules/ghostty-web',
    );
  });

  test('strips windows-style path', () => {
    expect(ghosttyWebRootFromMain('C:\\node_modules\\ghostty-web\\dist\\index.js')).toBe(
      'C:\\node_modules\\ghostty-web',
    );
  });
});
