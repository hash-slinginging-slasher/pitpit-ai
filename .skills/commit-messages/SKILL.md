---
name: commit-messages
description: Write clear, conventional git commit messages for this project.
when: writing a commit message or summarizing a change
---

# Commit messages

Write commit messages that explain the change and its reason, not just what changed.

## Subject line
- One line, imperative mood ("Add", "Fix", "Refactor" — not "Added"/"Fixes").
- <= 60 characters, no trailing period.
- Name the feature/area, not the file: `Add @mention file references in the CLI`.

## Body (when the change is non-trivial)
- A blank line, then wrap at ~80 columns.
- Explain *why* and any behavior/edge cases, not a diff restatement.
- Note user-facing effects (new commands, flags, config).

## Rules
- One logical change per commit. Don't bundle unrelated edits.
- Never commit secrets (`.env`, keys) — they're gitignored for a reason.
- Match the repo's existing style; skim `git log` first if unsure.
