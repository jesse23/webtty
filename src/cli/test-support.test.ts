// Self-tests of the CLI test helpers, kept beside test-support/ because a test-support folder
// holds no *.test.ts (ADR 064): a command that reaches a host its fake deps were not given fails.
import { describe, expect, test } from 'bun:test';
import { fakeCliDeps } from './test-support/fake-cli-deps';

describe('fakeCliDeps', () => {
  test('the default editor fails the test on any use', () => {
    const { editor } = fakeCliDeps().deps;
    const uses: Array<() => unknown> = [
      () => editor.configDir(),
      () => editor.mkdirp('/x'),
      () => editor.exists('/x'),
      () => editor.writeFile('/x', ''),
      () => editor.runAttached('vi', []),
    ];
    for (const use of uses) expect(use).toThrow('unexpected use of editor');
  });

  test('the default tty fails the test on any use', () => {
    const { tty } = fakeCliDeps().deps;
    const uses: Array<() => unknown> = [
      () => tty.setRawMode(true),
      () => tty.resume(),
      () => tty.onData(() => {}),
      () => tty.once('exit', () => {}),
      () => tty.off('exit', () => {}),
    ];
    for (const use of uses) expect(use).toThrow('unexpected use of tty');
  });
});
