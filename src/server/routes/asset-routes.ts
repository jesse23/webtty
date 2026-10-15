// Static assets: the client bundle under `/dist/` and the libghostty-vt wasm (ADR 062).
// Route handlers; both answer any method, as the old if-chain did.
import path from 'node:path';
import { sendNotFound } from '../http/respond';
import type { Route } from '../http/router';
import { GHOSTTY_WASM, serveFile } from '../http/static-files';

/** Where the assets are on disk. */
export interface AssetRouteDeps {
  /** The client dist directory (or src/client in a dev checkout). */
  clientDistPath: string;
  /** The wasm served at `/ghostty-vt-small.wasm`. */
  wasmPath: string;
}

/** The `/dist/*` and wasm routes. */
export function assetRoutes(deps: AssetRouteDeps): Route[] {
  return [
    {
      method: '*',
      path: /^\/dist\/(.*)$/,
      handle: ({ res, params }) => {
        // Only files inside the dist directory; `..` segments that climb out are a 404.
        const ownFile = path.resolve(deps.clientDistPath, params[0]);
        if (ownFile.startsWith(deps.clientDistPath + path.sep)) {
          serveFile(ownFile, res);
          return;
        }
        sendNotFound(res);
      },
    },
    {
      method: '*',
      path: `/${GHOSTTY_WASM}`,
      handle: ({ res }) => serveFile(deps.wasmPath, res),
    },
  ];
}
