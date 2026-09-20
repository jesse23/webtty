import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { getVersion } from './version';

describe('getVersion', () => {
  test('matches the version in package.json', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.resolve(import.meta.dir, '../package.json'), 'utf8'),
    );
    expect(getVersion()).toBe(pkg.version);
  });
});
