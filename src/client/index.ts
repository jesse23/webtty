// The browser entry, bundled to dist/client-browser.js (entry, ADR 060): starts the client
// on the page's own globals. Everything it builds, and the order, is in app/start-client.ts.

import { browserEnv } from './app/browser-env';
import { startClient } from './app/start-client';

await startClient(browserEnv());
