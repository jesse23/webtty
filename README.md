<img src="assets/social-preview.png" width="600">

# webtty

Terminal UI in the browser. Run CLI/TUI applications in a browser tab, across platforms.

```sh
npx webtty           # start server + open a terminal in the browser
npx webtty ls        # list sessions
npx webtty help      # show all commands
```

## Debugging

Build emits source maps (`dist/**/*.js.map`), so you can debug against the built output directly — no minification, original TypeScript line numbers preserved.

```
bun run build
bun --inspect run dist/server/index.js
# or
node --inspect dist/server/index.js
```
