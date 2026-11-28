# Extension Workspace Conventions

Files in this workspace live under `extension/` (bundled built-ins overlaid with your Git-versioned Cloudflare Artifacts repository):

- `extension.ts` — optional default entrypoint module
- `instructions.md` — workspace conventions (this file)
- `tools/` — reusable TypeScript tool modules executed via `run_module`
- `channels/`, `connections/`, `schedules/`, `subagents/`, `hooks/` — feature modules
- `skills/<name>/SKILL.md` — reusable playbooks (read with `read_file`)
- `lib/` — shared TypeScript helpers imported via relative paths (e.g. `../lib/math.ts`)

## Stateless vs Stateful Modules

- **Stateless (default):** export `default { async fetch(request: Request) { ... } }` and invoke with `run_module({ path, input })`.
- **Stateful (opt-in):** export a `DurableObject` subclass using `this.ctx.storage.sql` and invoke with `run_module({ path, facet, className, input })` to run inside an isolated child Durable Object facet with its own persistent SQLite database.

## Agent SQLite Database

Use `sqlite_query` to query or update `user_profile`, `memory_notes`, `memory_notes_fts`, `activities`, and conversation history tables. Secrets live in an isolated host facet and are never stored in this database.
