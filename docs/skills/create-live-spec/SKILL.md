---
name: create-live-spec
description: Create SPEC documents following the project's conventions. Use when the user wants to create a new SPEC, document a new module or initiative, or start a new architecture overview. Triggers on 'create a spec', 'new spec', 'write a spec for', 'document module', 'SPEC for'.
---

# Create Live Spec

## When to use this skill

Apply when the user wants to:

- Create a new SPEC (living architecture document)
- Document a new module, repo-level concern, or initiative
- Start an architecture overview for a feature area
- Ask "write a spec for X" or "create a spec"

This skill creates the **SPEC document only**. For ADRs that accompany a SPEC, use the `architecture-decision-records` skill.


## Workflow

### 1. Gather intent

Ask (or infer from context) what the SPEC is for:

- **Full title** — e.g. "Terminal Renderer", "Auth Flow"
- **One-line description** — what the module or initiative does
- **Persona** — who uses it (e.g. "CLI developers", "end users")
- **Initial features** — if the user already knows what features to track (optional)
- **Scope** — for large projects using scoped doc paths (`docs/{package}/specs/`), which package scope to use (default: `docs/specs/`)

If the user provides a clear description, don't over-prompt — derive what you can.

### 2. Derive short-title

Convert the full title to a filename-safe short-title:

- Lowercase
- Replace spaces and special characters with hyphens
- Trim leading/trailing hyphens
- Example: "Terminal Renderer" → `terminal-renderer`

Validate: check if `docs/specs/{short-title}.md` already exists. If it does, warn the user and ask how to proceed.

### 3. Generate the SPEC file

Create the file at `docs/specs/{short-title}.md` (or `docs/{package}/specs/{short-title}.md` for scoped projects) using the template in **[assets/spec-template.md](assets/spec-template.md)**. Follow the placeholder rules described there.

### 4. Populate the features table

- If the user provided features, add one row per feature.
- Set the **ADR** column to `—` (em dash) for each — ADRs haven't been written yet.
- Set **Done?** to `⬜` for all.
- If no features were provided, include a single placeholder row that the user can edit.

### 5. Report

After creating the file, tell the user:

- The file path
- Next step: write ADRs for the features using the `architecture-decision-records` skill, then link them in the Features table

## SPEC rules

- SPECs have no ID — they're living documents, not versioned artifacts
- One SPEC per module or repo-level concept — don't combine unrelated topics
- Update `Last Updated` and the Features table whenever an ADR is accepted or a feature ships
- For large projects, nest under `docs/{package}/specs/` — same conventions apply

## Keywords

create-live-spec, new spec, write a spec, SPEC document, architecture overview, module spec, living document, feature tracker