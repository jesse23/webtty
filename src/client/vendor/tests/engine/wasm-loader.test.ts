import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  DEFAULT_WASM_LOADER_DEPS,
  DEFAULT_WASM_URL,
  defaultWasmPaths,
  loadWasmExports,
  readWasm,
  type WasmLoaderDeps,
} from '../../ghostty-web/engine/wasm-loader';
import { WASM_PATH } from '../support/wasm';

// The wasm loader (ADR 061): the default path, the order it reads in, and its errors,
// through an injected reader and fetch.

const LOADER_PATH = fileURLToPath(
  new URL('../../ghostty-web/engine/wasm-loader.ts', import.meta.url),
);

const wasmBytes = () => Bun.file(WASM_PATH).arrayBuffer();

/** A reader that finds no local file and a fetch that answers from `responses`, recording paths. */
function fakeDeps(respond: (path: string) => Promise<Response>) {
  const fetched: string[] = [];
  const read: string[] = [];
  const deps: WasmLoaderDeps = {
    readFile: async (p) => {
      read.push(p);
      return undefined;
    },
    fetch: (p) => {
      fetched.push(p);
      return respond(p);
    },
  };
  return { deps, fetched, read };
}

describe('DEFAULT_WASM_URL', () => {
  test('resolves from engine/ to the pinned wasm', () => {
    const resolved = fileURLToPath(new URL(DEFAULT_WASM_URL, pathToFileURL(LOADER_PATH)));
    expect(resolved).toBe(path.resolve(WASM_PATH));
  });
});

describe('defaultWasmPaths', () => {
  test.each([
    {
      name: 'a file URL is tried as a path first',
      url: 'file:///opt/w/ghostty-vt-small.wasm',
      paths: [
        '/opt/w/ghostty-vt-small.wasm',
        'file:///opt/w/ghostty-vt-small.wasm',
        './ghostty-vt-small.wasm',
        '/ghostty-vt-small.wasm',
      ],
    },
    {
      name: 'a Windows drive path loses its leading slash',
      url: 'file:///C:/w/ghostty-vt-small.wasm',
      paths: [
        'C:/w/ghostty-vt-small.wasm',
        'file:///C:/w/ghostty-vt-small.wasm',
        './ghostty-vt-small.wasm',
        '/ghostty-vt-small.wasm',
      ],
    },
    {
      name: 'an http URL is fetched as is',
      url: 'http://h/a/ghostty-vt-small.wasm',
      paths: [
        'http://h/a/ghostty-vt-small.wasm',
        './ghostty-vt-small.wasm',
        '/ghostty-vt-small.wasm',
      ],
    },
  ])('$name', ({ url, paths }) => {
    expect(defaultWasmPaths(new URL(url))).toEqual([...paths]);
  });
});

describe('readWasm', () => {
  test('a local file is read without a fetch', async () => {
    const bytes = new Uint8Array([1, 2, 3]).buffer;
    const fetched: string[] = [];
    const deps: WasmLoaderDeps = {
      readFile: async () => bytes,
      fetch: async (p) => {
        fetched.push(p);
        return new Response('');
      },
    };
    expect(await readWasm('/x.wasm', deps)).toBe(bytes);
    expect(fetched).toEqual([]);
  });

  test('otherwise the injected fetch is used', async () => {
    const { deps, fetched, read } = fakeDeps(async () => new Response(new Uint8Array([7])));
    expect(new Uint8Array(await readWasm('/ghostty-vt-small.wasm', deps))).toEqual(
      new Uint8Array([7]),
    );
    expect(read).toEqual(['/ghostty-vt-small.wasm']);
    expect(fetched).toEqual(['/ghostty-vt-small.wasm']);
  });

  test('an empty body is an error naming the path', async () => {
    const { deps } = fakeDeps(async () => new Response(new Uint8Array(0)));
    await expect(readWasm('/empty.wasm', deps)).rejects.toThrow(
      'WASM file is empty (0 bytes). Check path: /empty.wasm',
    );
  });

  test('a failed fetch is an error with its status', async () => {
    const { deps } = fakeDeps(
      async () => new Response('nope', { status: 404, statusText: 'Not Found' }),
    );
    await expect(readWasm('/missing.wasm', deps)).rejects.toThrow(
      'Failed to fetch WASM: 404 Not Found',
    );
  });
});

describe('loadWasmExports', () => {
  test('a given path is loaded through the injected fetch', async () => {
    const bytes = await wasmBytes();
    const { deps, fetched } = fakeDeps(async () => new Response(bytes));
    const ex = await loadWasmExports('/ghostty-vt-small.wasm', deps);
    expect(fetched).toEqual(['/ghostty-vt-small.wasm']);
    expect(typeof ex.ghostty_terminal_new).toBe('function');
    expect(ex.memory).toBeInstanceOf(WebAssembly.Memory);
  });

  test('with no path, the default paths are tried in order until one loads', async () => {
    const bytes = await wasmBytes();
    const { deps, fetched } = fakeDeps(async (p) =>
      p === '/ghostty-vt-small.wasm' ? new Response(bytes) : new Response('', { status: 404 }),
    );
    const ex = await loadWasmExports(undefined, deps, new URL('http://h/a/ghostty-vt-small.wasm'));
    expect(fetched).toEqual([
      'http://h/a/ghostty-vt-small.wasm',
      './ghostty-vt-small.wasm',
      '/ghostty-vt-small.wasm',
    ]);
    expect(typeof ex.ghostty_terminal_free).toBe('function');
  });

  test('with no path and nothing loading, the last error is thrown', async () => {
    const { deps } = fakeDeps(async (p) =>
      p === '/ghostty-vt-small.wasm' ? new Response(new Uint8Array(0)) : Promise.reject('offline'),
    );
    await expect(
      loadWasmExports(undefined, deps, new URL('http://h/ghostty-vt-small.wasm')),
    ).rejects.toThrow('WASM file is empty (0 bytes). Check path: /ghostty-vt-small.wasm');
  });

  test('a non-Error rejection is wrapped', async () => {
    const { deps } = fakeDeps(() => Promise.reject('offline'));
    await expect(
      loadWasmExports(undefined, deps, new URL('http://h/ghostty-vt-small.wasm')),
    ).rejects.toThrow('offline');
  });
});

describe('the production reader', () => {
  test('reads the pinned wasm from disk with Bun.file', async () => {
    const bytes = await DEFAULT_WASM_LOADER_DEPS.readFile(WASM_PATH);
    expect(bytes?.byteLength).toBe(Bun.file(WASM_PATH).size);
  });

  test('a missing file is undefined, for the fetch to try', async () => {
    expect(await DEFAULT_WASM_LOADER_DEPS.readFile('/no/such/ghostty-vt.wasm')).toBeUndefined();
  });

  test('a path Bun.file cannot open is undefined too', async () => {
    expect(await DEFAULT_WASM_LOADER_DEPS.readFile('\0')).toBeUndefined();
  });

  test('loads the default wasm with no path and no deps', async () => {
    const ex = await loadWasmExports();
    expect(typeof ex.ghostty_terminal_new).toBe('function');
  });

  test('fetches through the global fetch', async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response(new Uint8Array([9, 9])),
    });
    try {
      const response = await DEFAULT_WASM_LOADER_DEPS.fetch(`http://localhost:${server.port}/w`);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([9, 9]));
    } finally {
      server.stop(true);
    }
  });
});
