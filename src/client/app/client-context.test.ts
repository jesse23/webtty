import { describe, expect, test } from 'bun:test';
import { installClipboard } from '../features/clipboard/clipboard-feature';
import { installFind } from '../features/find/find-feature';
import { installFontZoom } from '../features/keyboard/font-zoom-feature';
import { installKeyDispatcher } from '../features/keyboard/key-dispatcher';
import { installKitty } from '../features/kitty/kitty-feature';
import { installNotifications } from '../features/notifications/notifications-feature';
import { installPaste } from '../features/paste/paste-feature';
import { installScroll } from '../features/scroll/scroll-feature';
import { installTabTitle } from '../features/tab-title/tab-title-feature';
import { installLayout } from '../layout/layout-feature';
import { installRepaintOnVisible } from '../layout/repaint-on-visible';
import type { FeatureInstaller } from './client-context';

// The compiler checks every installer against the `install<Name>(ctx, deps)` contract:
// it takes the ClientContext (and its own deps) and returns a Disposable feature.
const installers = {
  installClipboard,
  installFind,
  installFontZoom,
  installKeyDispatcher,
  installKitty,
  installLayout,
  installNotifications,
  installPaste,
  installRepaintOnVisible,
  installScroll,
  installTabTitle,
} satisfies Record<string, FeatureInstaller<never>>;

describe('FeatureInstaller', () => {
  test('every installer the root calls is named install<Name>', () => {
    for (const [name, install] of Object.entries(installers)) {
      expect(name).toMatch(/^install[A-Z]\w*$/);
      expect(install.name).toBe(name);
    }
  });
});
