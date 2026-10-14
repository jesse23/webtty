// The CLI's view of where the server listens and whether it answers: the config-derived base
// URL and the reachability probe. A small service; the session calls move to WebttyClient in
// api-client.ts (ADR 063).
import { loadConfig } from '../config';

/** Active server port, read from config on first call (env PORT is intentionally ignored). */
export function getPort(): number {
  return loadConfig().port;
}

/** Base URL for internal CLI↔server API calls (always 127.0.0.1, avoids IPv6 lookup). */
export function getBaseUrl(): string {
  return `http://127.0.0.1:${getPort()}`;
}

/** Returns `true` if the webtty server is reachable and responding to API requests. */
export async function isServerRunning(): Promise<boolean> {
  try {
    const res = await fetch(`${getBaseUrl()}/api/sessions`);
    if (!res.ok) return false;
    const body = await res.json();
    return Array.isArray(body);
  } catch {
    return false;
  }
}
