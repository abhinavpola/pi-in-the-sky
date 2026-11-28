---
name: skill-creator
description: "Author, repair, validate, or restructure SKILL.md files and extension/ modules in the agent workspace."
source: "Adapted from OpenClaw (openclaw/openclaw, skills/skill-creator/SKILL.md)"
author: "OpenClaw"
license: MIT
---

# Skill Creator

Use this workflow when creating or improving a reusable skill in `extension/skills/<name>/SKILL.md` or supporting TypeScript modules in `extension/`.

## Workflow

1. **Inspect existing built-ins and overrides first.**
   - Call `list_files` and `read_file` on existing skills (e.g. `instructions.md`, `skills/email-inbox-triage/SKILL.md`) to match workspace conventions.
   - Separate distinct workflow branches from mere synonyms.
   - **Done when:** every branch has a concrete trigger, expected outcome, and tool boundary.

2. **Write focused frontmatter.**
   - Required fields: `name` (kebab-case matching folder name) and `description` (model-facing routing conditions: when to use the skill).
   - Add `source`, `author`, and `license` when adapting an external skill.
   - **Done when:** `description` makes it obvious when to load the skill without reading the body.

3. **Structure the body for execution.**
   - Put the ordered procedure directly in `SKILL.md`; end key steps with a checkable completion criterion and finish with a short **Verification** checklist.
   - Reference exact workspace tools (`sqlite_query`, `gmail_*`, `calendar_list_events`, `browser_*`, `read_file`, `write_file`, `run_module`).
   - Put reusable TypeScript helpers in `lib/` and executable entrypoints in `tools/` (stateless by default, or export a `DurableObject` class + `facet` when durable private SQLite state is needed).
   - **Done when:** every referenced file path exists or is created in the same change.

4. **Persist and verify.**
   - Save via `write_file` (remembering that writing a built-in path creates an Artifacts override, and `delete_file` restores the built-in).
   - If the skill includes TypeScript modules, execute and verify them with `run_module`.
   - **Done when:** `list_files` shows the skill, `read_file` returns valid frontmatter, and any accompanying modules pass `run_module`.
