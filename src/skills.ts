import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { APP_DIR } from './config.js';

/**
 * Skills: reusable natural-language instruction documents the coder agent can load
 * on demand. Layout is Claude-Code / SkillOpt compatible:
 *
 *   .skills/<name>/SKILL.md      (a directory per skill, so it can bundle files later)
 *   .skills/<name>.md            (flat form also accepted)
 *
 * SKILL.md may start with YAML-ish frontmatter (`name`, `description`, optional `when`).
 * A raw SkillOpt `best_skill.md` (body only, no frontmatter) works too — the name comes
 * from the folder/file and the description from the first heading/line.
 */

export interface Skill {
  name: string;
  description: string;
  when?: string; // optional "use when …" hint
  body: string; // instructions (frontmatter stripped)
  path: string; // path to the SKILL.md file
  source: 'global' | 'project'; // install-wide (APP_DIR) vs. this project (cwd)
}

export const SKILLS_DIR = '.skills';

/** Split leading `--- … ---` frontmatter from the body. Tolerant of a BOM / missing block. */
function parseFrontmatter(raw: string): { data: Record<string, string>; body: string } {
  const text = raw.replace(/^﻿/, '');
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { data: {}, body: text };
  const data: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (kv) data[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return { data, body: m[2] };
}

/** First non-empty line of the body, heading markers stripped — a description fallback. */
function firstLine(body: string): string {
  for (const line of body.split(/\r?\n/)) {
    const t = line.replace(/^#+\s*/, '').trim();
    if (t) return t.slice(0, 160);
  }
  return '';
}

export function skillsDir(workDir: string): string {
  return join(workDir, SKILLS_DIR);
}

/** Discover all skills under `<root>/.skills/`. Missing dir → []. */
export function loadSkills(root: string, source: 'global' | 'project' = 'project'): Skill[] {
  const dir = skillsDir(root);
  if (!existsSync(dir)) return [];
  const skills: Skill[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const entry of entries) {
    let file: string | null = null;
    let folderName = entry.name;
    if (entry.isDirectory()) {
      const p = join(dir, entry.name, 'SKILL.md');
      if (existsSync(p)) file = p;
    } else if (entry.isFile() && /\.md$/i.test(entry.name) && !/^readme\.md$/i.test(entry.name)) {
      file = join(dir, entry.name);
      folderName = entry.name.replace(/\.md$/i, '');
    }
    if (!file) continue;
    try {
      const { data, body } = parseFrontmatter(readFileSync(file, 'utf-8'));
      const trimmed = body.trim();
      skills.push({
        name: (data.name || folderName).trim(),
        description: (data.description || firstLine(trimmed)).trim(),
        when: (data.when || data['when_to_use'] || '').trim() || undefined,
        body: trimmed,
        path: file,
        source,
      });
    } catch {
      /* skip unreadable skill */
    }
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * All skills visible from a project: install-wide skills in `APP_DIR/.skills/` (shared
 * across every project, like the model + API key) merged with the project's own
 * `cwd/.skills/`. A project skill overrides a global one of the same name.
 */
export function loadSkillsFor(workDir: string): Skill[] {
  const byName = new Map<string, Skill>();
  for (const s of loadSkills(APP_DIR, 'global')) byName.set(s.name.toLowerCase(), s);
  if (workDir !== APP_DIR) {
    for (const s of loadSkills(workDir, 'project')) byName.set(s.name.toLowerCase(), s);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Compact "name: description" list for the system prompt (empty string if no skills). */
export function skillIndex(skills: Skill[]): string {
  return skills
    .map((s) => `- ${s.name}: ${s.description || '(no description)'}${s.when ? ` — use when ${s.when}` : ''}`)
    .join('\n');
}

/** Resolve an `@token` to a skill: exact name, hyphen-normalized, then substring. */
export function findSkill(skills: Skill[], token: string): Skill | undefined {
  const t = token.toLowerCase();
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, '-');
  return (
    skills.find((s) => s.name.toLowerCase() === t) ||
    skills.find((s) => norm(s.name) === t) ||
    skills.find((s) => norm(s.name).includes(t))
  );
}
