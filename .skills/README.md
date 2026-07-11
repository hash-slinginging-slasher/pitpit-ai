# Skills

Reusable natural-language instruction documents the coder agent can load on demand.
Each skill teaches the agent how to do a specific kind of task well.

## Two locations

The CLI runs inside whatever project you're coding on, but looks for skills in two places
(same idea as the shared model + API key):

- **Global** — `.skills/` in the agent's install dir (this folder). Available in **every** project.
- **Project** — `.skills/` in the current working directory. Only that project; overrides a
  global skill of the same name.

`/skills` tags each one `[global]` or `[project]`.

## Layout

```
.skills/
  <skill-name>/
    SKILL.md        # the skill (frontmatter + instructions)
  <other-skill>.md  # flat form also works
```

## Format

`SKILL.md` starts with optional frontmatter, then the instructions:

```markdown
---
name: react-components
description: Build React function components with our conventions.
when: the task is to create or edit a React component
---

Write function components (no classes). Co-locate the test as `<Name>.test.tsx`.
Use CSS modules, never inline styles. Export the component as the default export.
...
```

- **name** — how you invoke it (`@react-components`). Defaults to the folder/file name.
- **description** — one line; shown in `/skills` and advertised to the model. Defaults to the first heading/line of the body.
- **when** — optional hint for when the skill applies.

## Using a skill

- `/skills` — list available skills in the CLI.
- Mention `@<name>` in a message to load a skill; its full instructions are inserted and the
  agent follows them. Example: `refactor this to a hook @react-components`.
- The model always sees the **name + description** of every skill (a lightweight index), so it
  knows what's available even before you load one.

## SkillOpt compatibility

A skill body is just markdown, so an optimized [SkillOpt](https://github.com/microsoft/SkillOpt)
`best_skill.md` drops straight in — no editing required:

```
.skills/<name>/SKILL.md   <-  rename/copy your best_skill.md here
```

Frontmatter is optional: with none, the skill name comes from the folder and the description
from the first line of the file. Add frontmatter if you want a nicer name/description.
