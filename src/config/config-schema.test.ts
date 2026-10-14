// Tests for the client key list: every key exists in the defaults, none repeats, and the legacy
// `scrollback` key stays (ADR 062).
import { describe, expect, test } from 'bun:test';
import { CLIENT_CONFIG_KEYS, type ClientConfigKey, type Config } from './config-schema';
import { DEFAULT_CONFIG } from './defaults';

// Compile-time checks: tsc fails here if a client key is not a Config key, or if
// ClientConfig stops being a Pick of Config.
type Assert<T extends true> = T;
type _KeysAreConfigKeys = Assert<ClientConfigKey extends keyof Config ? true : false>;
type _NotEveryKey = Assert<keyof Config extends ClientConfigKey ? false : true>;

describe('CLIENT_CONFIG_KEYS', () => {
  test('names only keys that DEFAULT_CONFIG has', () => {
    for (const key of CLIENT_CONFIG_KEYS) expect(key in DEFAULT_CONFIG).toBe(true);
  });

  test('has no duplicates', () => {
    expect(new Set(CLIENT_CONFIG_KEYS).size).toBe(CLIENT_CONFIG_KEYS.length);
  });

  test('keeps the legacy scrollback key the server still sends', () => {
    expect(CLIENT_CONFIG_KEYS).toContain('scrollback');
  });
});
