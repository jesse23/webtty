import { describe, expect, mock, spyOn, test } from 'bun:test';
import fs from 'node:fs';
import { mimeType, serveFile } from './static-files';

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
    expect(mimeType('/dist/client-browser.js')).toBe('application/javascript');
    expect(mimeType('/dist/ghostty-vt.wasm')).toBe('application/wasm');
  });
});

describe('serveFile', () => {
  test('serves file with correct content type', async () => {
    const existsSpy = spyOn(fs, 'readFile').mockImplementation(((
      _path: unknown,
      cb: (err: null, data: Buffer) => void,
    ) => {
      cb(null, Buffer.from('<html>'));
    }) as typeof fs.readFile);

    const res = {
      writeHead: mock(() => {}),
      end: mock(() => {}),
    };

    serveFile('test.html', res as never);
    await Bun.sleep(10);

    expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'text/html' });
    expect(res.end).toHaveBeenCalledWith(Buffer.from('<html>'));
    existsSpy.mockRestore();
  });

  test('returns 404 when file not found', async () => {
    const existsSpy = spyOn(fs, 'readFile').mockImplementation(((
      _path: unknown,
      cb: (err: NodeJS.ErrnoException) => void,
    ) => {
      cb(Object.assign(new Error('not found'), { code: 'ENOENT' }) as NodeJS.ErrnoException);
    }) as typeof fs.readFile);

    const res = {
      writeHead: mock(() => {}),
      end: mock(() => {}),
    };

    serveFile('missing.html', res as never);
    await Bun.sleep(10);

    expect(res.writeHead).toHaveBeenCalledWith(404);
    expect(res.end).toHaveBeenCalledWith('Not Found');
    existsSpy.mockRestore();
  });
});
