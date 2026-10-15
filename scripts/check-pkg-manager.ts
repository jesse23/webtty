// The preinstall guard: refuses an install by npm, pnpm or yarn, since the project is
// managed with Bun and its lockfile is bun.lock (entry, ADR 059). The detection and the
// message are pure functions, tested; the script runs them on npm_config_user_agent.

/** The package manager the user agent names when it is not Bun, or undefined for Bun or none. */
export function foreignPackageManager(agent: string): string | undefined {
  if (!agent || agent.startsWith('bun')) return undefined;
  return agent.split('/')[0] || 'unknown';
}

/** The error printed for a foreign package manager, with Bun's install command. */
export function foreignPackageManagerMessage(detected: string): string {
  return `
\x1b[31m  ERROR: This project uses Bun. Run \`bun install\` instead.\x1b[0m

  Detected: ${detected}
  Run:      bun install
`;
}

/** Prints the error and returns 1 for a foreign package manager, else returns 0. */
export function checkPackageManager(
  agent: string,
  error: (message: string) => void = console.error,
): number {
  const detected = foreignPackageManager(agent);
  if (detected === undefined) return 0;
  error(foreignPackageManagerMessage(detected));
  return 1;
}

if (import.meta.main) {
  const code = checkPackageManager(process.env.npm_config_user_agent ?? '');
  if (code !== 0) process.exit(code);
}
