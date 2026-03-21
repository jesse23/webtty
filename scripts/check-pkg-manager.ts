const agent = process.env.npm_config_user_agent ?? '';

if (agent && !agent.startsWith('bun')) {
  const detected = agent.split('/')[0] || 'unknown';
  console.error(`
\x1b[31m  ERROR: This project uses Bun. Run \`bun install\` instead.\x1b[0m

  Detected: ${detected}
  Run:      bun install
`);
  process.exit(1);
}
