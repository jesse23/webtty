# webtty

A web TTY for running CLI/TUI applications in a browser tab, across platforms.

## Debugging

Build emits source maps (`dist/*.js.map`), so you can debug against the built output directly — no minification, original TypeScript line numbers preserved.

```
bun run build
bun --inspect run dist/server/index.js
# or
node --inspect dist/server/index.js
```
