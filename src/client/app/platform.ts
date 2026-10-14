// What the client asks of the browser's platform and focus state (util; ADR 053,
// ADR 054). The navigator and the document come in as arguments.

/** The navigator fields the platform check reads; `userAgentData` is Chromium-only. */
export interface PlatformSource {
  readonly platform: string;
  readonly userAgentData?: { readonly platform: string };
}

/** Whether the browser's platform takes Ghostty's macOS defaults (iPadOS and iOS too). */
export function isMacPlatform(platform: string): boolean {
  return /mac|iphone|ipad|ipod/i.test(platform);
}

/**
 * Whether Ghostty's macOS key defaults apply (ADR 054): the User-Agent Client Hints
 * platform where the browser has it, else the legacy `navigator.platform`.
 */
export function detectMac(navigator: PlatformSource): boolean {
  return isMacPlatform(navigator.userAgentData?.platform || navigator.platform);
}

/** The terminal has focus: its tab is shown, its window focused, and focus is inside it (ADR 053). */
export function isTerminalFocused(
  doc: Pick<Document, 'visibilityState' | 'hasFocus' | 'activeElement'>,
  container: Pick<Node, 'contains'>,
): boolean {
  return (
    doc.visibilityState === 'visible' && doc.hasFocus() && container.contains(doc.activeElement)
  );
}
