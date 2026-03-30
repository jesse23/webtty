# SPEC Template

Use this exact format when generating a new SPEC. Fill placeholders from the user's description.

```markdown
# SPEC: {Full Title}

**Last Updated:** {YYYY-MM-DD}

---

## Description

{Description tailored to the scenario:
- User-facing feature → list the persona and key use cases
- DevOps / infra → describe the scenario and expected benefits
- Then provide an up-to-date architecture overview and any context needed for clarity}

**Persona:** {who uses this}

## Features

| Feature | Description | ADR | Done? |
|---------|-------------|-----|-------|
| {feature} | {one-line description} | — | ⬜ |
```

## Placeholder rules

- **{Full Title}**: The SPEC's full title, e.g. "Terminal Renderer".
- **{author}**: Author name or team. Default to "Team" if not specified.
- **{YYYY-MM-DD}**: Today's date in ISO format.
- **{Description}**: Tailor to the scenario (user-facing, DevOps/infra, etc.).
- **{who uses this}**: The persona, e.g. "CLI developers", "end users".
- **{feature}**: One row per feature. If no features provided, use a single placeholder row.
- **ADR column**: Set to `—` (em dash) until an ADR is written and linked.
- **Done? column**: Set to `⬜` for all new features.