# Live Spec Driven Development

A lightweight development process using a single living SPEC per module and Architecture Decision Records (ADRs)

---

## How It Works

Two document types, two purposes:

| Document | Purpose | Lifecycle |
|----------|---------|-----------|
| **SPEC** | Living architecture document + feature tracker for progress | Created once, updated continuously |
| **ADR** | Individual architectural or technology decision record | Created per decision, updated as needed |

**When to write a SPEC**: New module, new repo-level concern, or any initiative that needs a living architecture overview. A SPEC is not triggered by a count of ADRs — it represents a module or flow you want to track over time.

**When to write an ADR**: Any architectural or technology decision — even if the answer seems obvious. ADRs are the atomic unit that drives incremental development. Recording "obvious" decisions prevents future re-evaluation and makes onboarding faster.

**When to write neither**: Bug fixes, minor version upgrades, routine maintenance, implementation details.

---

## Naming Conventions

| Document | Pattern | Example |
|----------|---------|---------|
| SPEC | `{short-title}.md` | `my-new-module.md` |
| ADR | `{sequence}.{spec-title}.{adr-title}.md` | `001.server.websocket-protocol.md` |

```
docs/
├── specs/                # living architecture overviews
│   └── {short-title}.md
└── adrs/                 # decision records, flat sequence
    └── {seq}.{spec-title}.{adr-title}.md
```

**Sequencing**: ADR numbers are 3-digit, sequential across the entire repo, starting at `001`. They do not reset per SPEC — a single global sequence avoids conflicts when multiple SPECs produce ADRs simultaneously.

**SPEC-title prefix**: The SPEC name embedded in each ADR filename is the modularization axis. It enables filtering by scope (`ls adrs/*.server.*`) and makes ownership clear at a glance.

---

## SPEC Guidelines

- Use the **`create-live-spec`** skill to generate SPECs.
- SPECs have no ID — they're living documents, not versioned artifacts
- Update `Last Updated` and the Features table whenever an ADR is accepted or a feature ships
- One SPEC per module or repo-level concept — don't combine unrelated topics. Or one SPEC to a given repo level flow or mechanism

---

## ADR Guidelines

- Use the **`architecture-decision-records`** skill to generate or verify ADRs.
- ADRs are the atomic unit of incremental implementation — one work per ADR
- Include Considered Options when meaningful alternatives exist, but don't force it if the decision is straightforward
- ADRs can be updated (git history preserves the evolution) — if a decision fundamentally changes, write a new ADR and mark the old one `Superseded`
- Rejected decisions can be revised into a new Proposed ADR with better options, if the team decides to pursue the topic further
- Related Decisions is optional — include only when ADRs are genuinely related.

---

## Status Lifecycle

```
Proposed → Accepted → (Implemented via Features table in SPEC)
    ↓           ↓
 Rejected   Superseded
    ↓
 Proposed (revised with better options, if pursuing the topic further)
```

| Status | Meaning | Who Transitions |
|--------|---------|-----------------|
| **Proposed** | Under review, not yet agreed upon | Author creates |
| **Accepted** | Team agreed, ready to implement | Reviewer approves MR |
| **Superseded** | Replaced by a newer ADR (must link to it) | Author of replacement ADR / new MR |
| **Rejected** | Decision was not adopted | Reviewer rejects MR; author creates a doc MR to put a new Proposed ADR if needed |

**Acceptance criteria**: SPEC author + 1 reviewer approve the MR containing the ADR.

---

## MR Workflow

### Submitting a SPEC or ADR

Bundle the ADR (and SPEC updates) in the same MR as the implementation:

1. Include the ADR file(s) in the same MR as the implementation code
2. Mark the ADR status as `Accepted` directly (since the MR proves the decision)
3. Update the SPEC's Features table (`⬜` → `✅`) in the same MR
4. Reviewer approves code + decision together

If a developer wants to propose a SPEC or ADR independently first, they can submit a separate MR for it without having implementation ready.

### MR Template Checklist (recommended)

```markdown
## Decision Documentation
- [ ] Does this MR introduce a new architectural decision? If yes, include an ADR.
- [ ] Does this MR implement an existing ADR? If yes, link it below.
- [ ] ADR link: {url}
```

---

## Quick Decision Guide

| Scenario | Action |
|----------|--------|
| New module or repo-level concern | Write a **SPEC** in `docs/specs/`, then ADRs for each decision |
| New incremental change you decide to make | Write an **ADR** in `docs/adrs/` + link from spec |
| Implement a decided feature | Update SPEC's Features table `⬜` → `✅` |
| Change a previous decision | New ADR with `Superseded` status + update old ADR's status |
| Reject a considered approach | Revise into a new Proposed ADR with better options, if pursuing the topic further |
| Bug fix, config change, or routine update | Just write code — no spec or ADR needed |

---

## Anti-Patterns

| Anti-Pattern | Why It's Bad | Prevention |
|---|---|---|
| **Over-documentation** | Not every code change needs an ADR — process becomes a tax | Write ADRs for architectural/technology decisions, not implementation details |
| **Orphaned ADRs** | ADRs that are never updated after implementation | Tie "Done?" in the SPEC to actual implementation MRs |
| **ADR-as-permission** | Process gates implementation instead of recording decisions | If the team agrees in a call, write the ADR after — don't block shipping |
| **Stale SPECs** | Living doc that nobody updates is worse than no doc | Assign an owner per SPEC; review at sprint boundaries |
| **Skipping rejected decisions** | Future engineers will re-explore the same dead ends | Revise it back to Proposed ADR if needed |
