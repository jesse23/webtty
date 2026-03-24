import type { Config } from '../config';

export function render(sessionId: string, config: Config): string {
  const theme = config.theme;
  const themeJson = JSON.stringify(theme, null, 8).replace(/^/gm, '        ').trimStart();
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${sessionId} | webtty</title>
    <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect x='5' y='5' width='90' height='90' rx='18' fill='white'/><text x='8' y='73' font-size='58' font-family='monospace' font-weight='bold' fill='%23161b22'>>_</text></svg>">
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }

      html, body, #terminal { width: 100%; height: 100%; overflow: hidden; background: ${theme.background ?? '#282A36'}; }

      #terminal canvas { display: block; }
    </style>
  </head>
  <body>
    <div id="terminal"></div>

    <script type="module">
      import { init, Terminal, FitAddon } from '/dist/ghostty-web.js';

      await init();
      const term = new Terminal({
        cols: ${config.cols},
        rows: ${config.rows},
        cursorBlink: ${config.cursorBlink},
        fontSize: ${config.fontSize},
        fontFamily: ${JSON.stringify(config.fontFamily)},
        scrollback: ${Math.ceil(config.scrollback / 80)},
        theme: ${themeJson},
      });

      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);

      const container = document.getElementById('terminal');
      await term.open(container);
      fitAddon.fit();
      fitAddon.observeResize();

      const sessionId = ${JSON.stringify(sessionId)};
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      let ws;

      function connect() {
        const wsUrl = protocol + '//' + window.location.host + '/ws/' + sessionId + '?cols=' + term.cols + '&rows=' + term.rows;
        ws = new WebSocket(wsUrl);

        const DIM = '\\x1b[2m', YELLOW = '\\x1b[1;33m', ITALIC = '\\x1b[3m', RESET = '\\x1b[0m';
        const tag = DIM + '[' + RESET + ' ' + YELLOW + 'webtty' + RESET + ' ' + DIM + ']' + RESET;
        const msg = (text) => '\\r\\n' + tag + ' ' + DIM + ITALIC + text + RESET + '\\r\\n';

        ws.onopen = () => {
          ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
        };

        ws.onmessage = (event) => {
          term.write(event.data);
        };

        ws.onclose = (event) => {
          if (event.code === 4001) {
            term.write(msg('Session removed.'));
            setTimeout(() => window.close(), 500);
            return;
          }
          if (event.code === 1001) {
            term.write(msg('Server stopped.'));
            setTimeout(() => window.close(), 500);
            return;
          }
          term.write(msg('Connection lost. Reconnecting in 2s...'));          
          setTimeout(connect, 2000);
        };

        ws.onerror = () => {
          term.write(msg('WebSocket error.'));
        };
      }

      connect();

      term.onData((data) => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(data);
        }
      });

      term.onResize(({ cols, rows }) => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'resize', cols, rows }));
        }
      });

      window.addEventListener('resize', () => {
        fitAddon.fit();
      });
    </script>
  </body>
</html>`;
}
