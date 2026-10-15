# Agent Guide

This is `webtty` — a web TTY for running CLI/TUI applications in a browser tab, across platforms.

## Process

Follow [docs/development.md](docs/development.md) — Spec & ADR Driven Development. Every change starts with a SPEC and ADR before implementation.

## Repo Structure

```
webtty/
├── docs/
│   ├── specs/                   # living specs; specs/architecture.md maps the code
│   └── adrs/                    # architecture decision records
├── src/                         # cli/, server/, pty/, config/, client/ (tree in specs/architecture.md)
├── scripts/                     # build, architecture and coverage checks, ghostty-vt updater
└── README.md
```

## Development Workflow

Always build and stop the old server before testing:

```
bun run build && bun run webtty stop
```

## Rules

- **Match existing patterns** — read 2-3 similar files before writing new ones.
- **Don't create docs unprompted** — no SPECs or ADRs unless the work warrants one.
- **Pin dependencies** — no `^` or `~` ranges. Exact versions only.
