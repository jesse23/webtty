import { describe, expect, mock, spyOn, test } from 'bun:test';
import fs from 'node:fs';
import { findGhosttyWeb, ghosttyWebRootFromMain, mimeType, serveFile } from './static';

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

describe('findGhosttyWeb', () => {
  test('returns distPath and wasmPath when ghostty-web is installed', () => {
    const { distPath, wasmPath } = findGhosttyWeb();
    expect(distPath).toContain('ghostty-web');
    expect(wasmPath).toContain('ghostty-vt.wasm');
  });

  test('exits when ghostty-web files are missing', () => {
    const existsSpy = spyOn(fs, 'existsSync').mockReturnValue(false);
    const exitSpy = spyOn(process, 'exit').mockImplementation((() => {}) as () => never);
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    findGhosttyWeb();

    expect(exitSpy).toHaveBeenCalledWith(1);
    existsSpy.mockRestore();
    exitSpy.mockRestore();
    errorSpy.mockRestore();
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
