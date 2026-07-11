import { readFile } from 'fs/promises';
import { basename } from 'path';
import { glob } from 'glob';

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

export interface ResolvedMention {
  token: string;      // the text after @ (e.g. "prd")
  files: string[];    // posix-relative paths that matched (already deduped)
}

export interface MentionResolution {
  /** The message with an appended "Referenced files" block (unchanged if no @mentions). */
  text: string;
  matched: ResolvedMention[];
  unmatched: string[]; // tokens that matched no file
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

export async function resolveMentions(input: string, workDir: string): Promise<MentionResolution> {
  const tokens = findTokens(input);
  if (!tokens.length) return { text: input, matched: [], unmatched: [], truncated: false };

  const all = await glob('**/*', { cwd: workDir, nodir: true, ignore: IGNORE, posix: true });

  const matched: ResolvedMention[] = [];
  const unmatched: string[] = [];
  const seen = new Set<string>(); // dedupe files across tokens

  for (const token of tokens) {
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

  if (!matched.length) return { text: input, matched: [], unmatched, truncated: false };

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

  const text =
    `${input}\n\n---\nReferenced files (from @mentions — read these to answer):\n\n${blocks.join('\n\n')}`;
  return { text, matched, unmatched, truncated };
}
