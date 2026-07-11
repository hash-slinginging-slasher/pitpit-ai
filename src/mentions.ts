import { readFile } from 'fs/promises';
import { basename } from 'path';
import { glob } from 'glob';
import { findSkill, type Skill } from './skills.js';

/**
 * `@mention` file references in a CLI turn. Typing `@prd` fuzzy-matches project files
 * whose name/path contains "prd" and inlines their contents into the message, so the
 * model reads them without having to guess a path or call file_read. Resolved on send.
 */

const IGNORE = [
  '**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**',
  '**/.next/**', '**/coverage/**', '**/.venv/**', '**/__pycache__/**',
];

// Keep context bounded — @mentions can match several files.
const MAX_FILES = 12;
const MAX_FILE_BYTES = 100_000;
const MAX_TOTAL_BYTES = 300_000;

// Doc-ish files rank above code when a token matches both (the feature is aimed at docs).
const DOC_EXT = /\.(md|mdx|markdown|txt|rst|adoc|csv|json|ya?ml|pdf|docx?|xlsx?)$/i;

// Cache the file listing briefly — Tab completion calls the completer repeatedly, and a
// fresh `**/*` glob on every keypress would lag in a large repo.
const listCache = new Map<string, { at: number; files: string[] }>();
const LIST_TTL_MS = 3000;

async function listProjectFiles(workDir: string): Promise<string[]> {
  const hit = listCache.get(workDir);
  if (hit && Date.now() - hit.at < LIST_TTL_MS) return hit.files;
  const files = await glob('**/*', { cwd: workDir, nodir: true, ignore: IGNORE, posix: true });
  listCache.set(workDir, { at: Date.now(), files });
  return files;
}

export interface ResolvedMention {
  token: string;      // the text after @ (e.g. "prd")
  files: string[];    // posix-relative paths that matched (already deduped)
}

export interface MentionResolution {
  /** The message with appended skill + file blocks (unchanged if no @mentions resolved). */
  text: string;
  skills: string[];    // skill names loaded this turn (tokens that matched a skill)
  matched: ResolvedMention[];
  unmatched: string[]; // tokens that matched neither a skill nor a file
  truncated: boolean;  // hit a file/byte cap and left some content out
}

/** Extract `@token` mentions. A token is a path-ish run: letters, digits, . _ - / */
function findTokens(input: string): string[] {
  const out: string[] = [];
  for (const m of input.matchAll(/(^|\s)@([A-Za-z0-9._\-/]+)/g)) {
    const t = m[2].replace(/[.\/]+$/, ''); // drop trailing dots/slashes
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

/** Rank a candidate path against a token. Lower is better; null = no match. */
function score(relPath: string, token: string): number | null {
  const p = relPath.toLowerCase();
  const base = basename(p);
  const t = token.toLowerCase();
  const noExt = base.replace(/\.[^.]+$/, '');
  let s: number;
  if (base === t || noExt === t) s = 0;
  else if (base.startsWith(t)) s = 1;
  else if (base.includes(t)) s = 2;
  else if (p.includes(t)) s = 3;
  else return null;
  if (DOC_EXT.test(base)) s -= 0.5; // nudge docs ahead of code at the same tier
  return s;
}

/** True if the buffer looks binary (NUL byte in the first chunk) — don't inline those. */
function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export async function resolveMentions(
  input: string,
  workDir: string,
  skills: Skill[] = [],
): Promise<MentionResolution> {
  const tokens = findTokens(input);
  if (!tokens.length) return { text: input, skills: [], matched: [], unmatched: [], truncated: false };

  const all = await listProjectFiles(workDir);

  const skillBlocks: string[] = [];
  const skillsLoaded: string[] = [];
  const seenSkill = new Set<string>();
  const matched: ResolvedMention[] = [];
  const unmatched: string[] = [];
  const seen = new Set<string>(); // dedupe files across tokens

  for (const token of tokens) {
    // A token is a skill first, files second. @react-components loads a skill; @prd, files.
    const skill = findSkill(skills, token);
    if (skill) {
      if (!seenSkill.has(skill.name)) {
        seenSkill.add(skill.name);
        skillsLoaded.push(skill.name);
        skillBlocks.push(`<skill name="${skill.name}">\n${skill.body}\n</skill>`);
      }
      continue;
    }
    const ranked = all
      .map((f) => ({ f, s: score(f, token) }))
      .filter((r): r is { f: string; s: number } => r.s !== null)
      .sort((a, b) => a.s - b.s || a.f.length - b.f.length || a.f.localeCompare(b.f))
      .map((r) => r.f)
      .filter((f) => !seen.has(f));
    if (!ranked.length) {
      unmatched.push(token);
      continue;
    }
    const take = ranked.slice(0, MAX_FILES);
    take.forEach((f) => seen.add(f));
    matched.push({ token, files: take });
  }

  if (!matched.length && !skillBlocks.length) {
    return { text: input, skills: skillsLoaded, matched: [], unmatched, truncated: false };
  }

  // Inline the matched files (text only; binaries get a pointer to the view tools).
  let total = 0;
  let truncated = false;
  const blocks: string[] = [];
  for (const { files } of matched) {
    for (const rel of files) {
      if (total >= MAX_TOTAL_BYTES) { truncated = true; break; }
      try {
        const buf = await readFile(`${workDir}/${rel}`);
        if (isBinary(buf)) {
          blocks.push(`<file path="${rel}" note="binary — open with view_document or view_image" />`);
          continue;
        }
        let body = buf.toString('utf-8');
        if (body.length > MAX_FILE_BYTES) { body = body.slice(0, MAX_FILE_BYTES); truncated = true; }
        if (total + body.length > MAX_TOTAL_BYTES) {
          body = body.slice(0, MAX_TOTAL_BYTES - total);
          truncated = true;
        }
        total += body.length;
        blocks.push(`<file path="${rel}">\n${body}\n</file>`);
      } catch (err: any) {
        blocks.push(`<file path="${rel}" note="could not read: ${err.message}" />`);
      }
    }
  }

  const sections: string[] = [input, '---'];
  if (skillBlocks.length) {
    sections.push(
      'Apply the following skill(s) to this task — treat their instructions as authoritative:',
      skillBlocks.join('\n\n'),
    );
  }
  if (blocks.length) {
    sections.push('Referenced files (from @mentions — read these to answer):', blocks.join('\n\n'));
  }
  return { text: sections.join('\n\n'), skills: skillsLoaded, matched, unmatched, truncated };
}

/**
 * Readline completer for `@mentions`. When the line ends in a `@token`, returns matching
 * skill names and file paths so Tab completes them. Returns `[completions, replacedText]`
 * in the shape Node's readline expects; every completion begins with the `@token` being
 * replaced (readline swaps the trailing match for the chosen completion).
 *
 * For a bare token (no slash) it offers skill names and matching file **basenames**; once
 * the token contains a `/` it offers full relative **paths** so you can drill into folders.
 */
export async function mentionCompletions(
  line: string,
  workDir: string,
  skills: Skill[] = [],
): Promise<[string[], string]> {
  const m = line.match(/@([A-Za-z0-9._\-/]*)$/);
  if (!m) return [[], line];
  const token = m[1];
  const t = token.toLowerCase();
  const completeOn = '@' + token;
  const out = new Set<string>();

  if (!token.includes('/')) {
    for (const s of skills) if (s.name.toLowerCase().startsWith(t)) out.add('@' + s.name);
  }

  const files = await listProjectFiles(workDir);
  for (const f of files) {
    // Every candidate must start with completeOn or readline can't splice it in.
    if (f.toLowerCase().startsWith(t)) out.add('@' + f); // path-prefix (drilling)
    else if (!token.includes('/') && basename(f).toLowerCase().startsWith(t)) out.add('@' + basename(f));
  }

  return [[...out].sort().slice(0, 50), completeOn];
}
