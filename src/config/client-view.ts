// The client-safe view of a Config, served by `GET /api/config`. A pure util module built on
// the one key list in config-schema.ts, so the served keys and their order are defined once
// (ADR 062, architecture SPEC "Contracts across the client/server line").
import { CLIENT_CONFIG_KEYS, type ClientConfig, type Config } from './config-schema';

/** Picks {@link CLIENT_CONFIG_KEYS} from `config`, in that order, so server-only keys never reach the browser. */
export function toClientConfig(config: Config): ClientConfig {
  return Object.fromEntries(CLIENT_CONFIG_KEYS.map((key) => [key, config[key]])) as ClientConfig;
}
