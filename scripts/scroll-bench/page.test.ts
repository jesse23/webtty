import { describe, expect, test } from 'bun:test';
import { profileExpression } from './page';

describe('profileExpression', () => {
  const region = { x: 8, width: 600, channels: 'rg' } as const;
  const expression = profileExpression(['AAA=', 'BBB='], region);

  test('is one expression the page can evaluate', () => {
    // Compiles it without running it: the page's Image and OffscreenCanvas are not here.
    expect(() => new Function(`return () => ${expression};`)).not.toThrow();
  });

  test('carries the region and every frame, quoted as data', () => {
    expect(expression).toContain(JSON.stringify(region));
    expect(expression).toContain(JSON.stringify(['AAA=', 'BBB=']));
    const quoted = profileExpression(['"]; alert(1); //'], region);
    expect(() => new Function(`return () => ${quoted};`)).not.toThrow();
    expect(quoted).toContain(JSON.stringify(['"]; alert(1); //']));
  });
});
