<p align="center">
  <img src="docs/assets/social-preview.png" width="600">
</p>

# webtty

[![npm version](https://img.shields.io/npm/v/webtty)](https://www.npmjs.com/package/webtty)
[![CI](https://github.com/jesse23/webtty/actions/workflows/ci.yml/badge.svg)](https://github.com/jesse23/webtty/actions/workflows/ci.yml)

Terminal UI in the browser. Run CLI/TUI applications in a browser tab, across platforms. Powered by [ghostty-web](https://github.com/coder/ghostty-web).

- [Why webtty?](docs/awesome-web.md#terminal)

```sh
bunx webtty                # open main session in the browser
bunx webtty go [id]        # open a specific session by id
bunx webtty help           # show all commands

# or with npx
npx webtty
npx webtty go [id]
npx webtty help
```

> **Windows**: use `npx` — `bunx` is not supported on Windows because `Bun.spawn({ terminal })` does not implement PTY on Windows yet.

## Development

Build emits source maps (`dist/**/*.js.map`), so you can debug against the built output directly — no minification, original TypeScript line numbers preserved.

```sh
bun run build
bun --inspect run dist/server/index.js
# or
node --inspect dist/server/index.js
```
