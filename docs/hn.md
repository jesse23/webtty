Title:
Show HN: webtty – Run CLI/TUI apps in a browser tab (npx webtty)
URL:
https://github.com/jesse23/webtty
Text:
Built for people who like to keep everything in the browser — one window, fewer context switches, the terminal lives where the rest of your tools already are.
There are a few other browser terminals worth knowing:
- ttyd is solid and lightweight, but the session is destroyed when the WebSocket connection drops
- Zellij's web mode (v0.44.0, March 2026) supports the same, but I use vim as my base
- VS Code Server (`code serve-web`) is another good choice but you get the full IDE there.
- webtty is the KISS option: a pure terminal in the browser with a thin session layer on top. No multiplexer, no framework — just `bunx webtty` or `npx webtty`, works on macOS, Linux, and Windows (including CMD). No plans to make it rich or agentic — that's the point.
Under the hood it uses ghostty-web (Ghostty compiled to WebAssembly) for rendering, so proper TUI support — ncurses, vim, htop, lazygit all work.
Try it:
  npx webtty            # opens main session
  npx webtty go [id]    # named sessions as URLs
  npx webtty help
Would love feedback on the Windows experience especially, since that's the underserved case.

More on the browser-first terminal setup that motivated this:
https://github.com/jesse23/webtty/blob/main/docs/awesome-web.md
