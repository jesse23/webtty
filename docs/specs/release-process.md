# Release Process

**Last Updated**: 2026-03-21

## Overview

Automated release pipeline for wtty using semantic-release. Conventional commit prefixes in PR titles drive version bumps post-merge to `main`. semantic-release determines the version, publishes to npm, creates a GitHub Release with release notes, and pushes a git tag. No manual versioning, no release commits, no extra files. Git tags are the sole version record.

wtty targets developers who already have Node.js or Bun installed. Distribution is via `npx wtty` — no binary downloads needed.

## Principles

| # | Principle | Meaning |
|---|-----------|---------|
| 1 | Developers don't version | Merge to `main` with a conventional PR title — CI handles the rest. |
| 2 | Commit message is the changelog | PR title (squash merge commit message) is the changelog entry. No separate changeset files. |
| 3 | Git tags are the version record | `package.json` version stays at `0.0.0-development`. Tags are the source of truth. |
| 4 | Tag-only releases | No release commits pushed back to the repo. Clean one-commit-per-PR history. |

## Flow

```
PR                                   Post-Merge (main)
+----------------------------+        +------------------------------------------+
| lint, build, test          |   →    | semantic-release                         |
| (PR check workflow)        | squash | analyze commits → determine version bump |
+----------------------------+        | create GitHub Release + release notes    |
                                      | push git tag                             |
                                      +------------------------------------------+
```

### Developer Workflow

1. Open a PR to `main` with a conventional commit prefix in the title
2. Get review and approval
3. Squash merge — PR title becomes the single commit message on `main`
4. CI runs semantic-release post-merge:
   - `fix:` → patch bump (`0.1.0` → `0.1.1`)
   - `feat:` → minor bump (`0.1.0` → `0.2.0`)
   - `feat!:` / `BREAKING CHANGE:` → major bump (`0.1.0` → `1.0.0`)
   - `chore:`, `docs:`, `ci:` → no release
5. npm package published, GitHub Release created with tag and release notes

### Conventional Commit Prefixes

| Prefix | Bump | Example |
|--------|------|---------|
| `fix:` | Patch (0.0.x) | `fix: handle PTY exit on Windows` |
| `feat:` | Minor (0.x.0) | `feat: add config file support` |
| `feat!:` / `BREAKING CHANGE:` | Major (x.0.0) | `feat!: redesign WebSocket protocol` |
| `chore:`, `docs:`, `ci:` | No release | `chore: update dev deps` |

PRs that don't match a release prefix produce no release — no error, no tag.

## Pipeline Structure

### PR Check Workflow (`.github/workflows/ci.yml`)

Runs on every push to an open PR. No versioning.

### Release Workflow (`.github/workflows/release.yml`)

```yaml
on:
  push:
    branches: [main]
jobs:
  release:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          persist-credentials: false
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.3.10
      - run: bun install --frozen-lockfile
      - run: bun run build
      - name: Release
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          NPM_TOKEN: ${{ secrets.NPM_TOKEN }}
        run: bunx semantic-release
```

## Configuration

### `.releaserc.json`

```json
{
  "branches": ["main"],
  "tagFormat": "v${version}",
  "plugins": [
    "@semantic-release/commit-analyzer",
    "@semantic-release/release-notes-generator",
    "@semantic-release/npm",
    "@semantic-release/github"
  ]
}
```

## Version Progression

```
main branch:
  v0.1.0   (feat: bootstrap terminal server)
  v0.1.1   (fix: handle PTY exit on Windows)
  v0.2.0   (feat: add config file support)
  v1.0.0   (feat!: redesign WebSocket protocol)
```

## GitHub Settings (one-time)

| Setting | Value | Why |
|---------|-------|-----|
| Squash merging | Enabled | PR title becomes the commit message semantic-release reads |
| Workflow permissions | Read and write | `GITHUB_TOKEN` needs to push tags and create releases |
| `NPM_TOKEN` secret | npm Automation token | Settings → Secrets → Actions. Generate from npmjs.com → Access Tokens → Automation token. |

## Features

| Feature | Status | Reference |
|---------|--------|-----------|
| Automated versioning via conventional commits | ⬜ | [ADR 003](../adrs/003.release-process.semantic-release.md) |
| npm publish on release | ⬜ | [ADR 003](../adrs/003.release-process.semantic-release.md) |
| GitHub Release with release notes | ⬜ | [ADR 003](../adrs/003.release-process.semantic-release.md) |
