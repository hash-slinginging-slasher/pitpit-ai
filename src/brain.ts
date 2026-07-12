import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, appendFileSync } from 'fs';
import { join } from 'path';

/**
 * Project "brain" — a per-project markdown knowledge vault at `.codigo/brain/`.
 * Durable notes (architecture, decisions, gotchas, conventions, glossary) that the agent
 * both reads (relevant notes are retrieved into context) and writes (via the save_note
 * tool), and that you can curate directly in the Files panel. Versioned in git like any
 * other project file. This is Codigo's "second brain": long-term memory that survives
 * sessions and is handed from the orchestrator to the coders it delegates to.
 */

export const BRAIN_DIR = '.codigo/brain';

export interface BrainNote {
  name: string;
  content: string;
  path: string;
}

export function brainDir(cwd: string): string {
  return join(cwd, BRAIN_DIR);
}

/** Load every note in the vault. Missing dir → []. */
export function loadBrain(cwd: string): BrainNote[] {
  const dir = brainDir(cwd);
  if (!existsSync(dir)) return [];
  const out: BrainNote[] = [];
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }
  for (const f of files) {
    if (!/\.md$/i.test(f) || /^readme\.md$/i.test(f)) continue;
    try {
      out.push({ name: f.replace(/\.md$/i, ''), content: readFileSync(join(dir, f), 'utf-8'), path: join(dir, f) });
    } catch {
      /* skip unreadable */
    }
  }
  return out;
}

const STOP = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'you', 'are', 'was', 'but', 'not', 'have', 'has',
  'from', 'they', 'will', 'would', 'can', 'use', 'using', 'into', 'your', 'our', 'its', 'via',
]);
function tokenize(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9_]{3,}/g) || []).filter((t) => !STOP.has(t));
}

/** Keyword-retrieve the notes most relevant to `query`, bounded in count and size. */
export function retrieveBrain(
  cwd: string,
  query: string,
  opts?: { maxNotes?: number; perNoteChars?: number; totalChars?: number },
): BrainNote[] {
  const notes = loadBrain(cwd);
  if (!notes.length) return [];
  const q = new Set(tokenize(query));
  if (!q.size) return [];
  const scored = notes
    .map((n) => {
      let score = 0;
      for (const t of tokenize(n.content)) if (q.has(t)) score++;
      for (const t of tokenize(n.name)) if (q.has(t)) score += 4; // title match is a strong signal
      return { n, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  const maxNotes = opts?.maxNotes ?? 4;
  const perNoteChars = opts?.perNoteChars ?? 2500;
  const totalChars = opts?.totalChars ?? 7000;
  const out: BrainNote[] = [];
  let total = 0;
  for (const { n } of scored.slice(0, maxNotes)) {
    let c = n.content;
    if (c.length > perNoteChars) c = c.slice(0, perNoteChars) + '\n…(truncated)';
    if (total + c.length > totalChars) break;
    total += c.length;
    out.push({ ...n, content: c });
  }
  return out;
}

/** Formatted brain context for injection, or '' if no relevant notes. */
export function brainContext(cwd: string, query: string): string {
  const notes = retrieveBrain(cwd, query);
  if (!notes.length) return '';
  return (
    `# Project brain (relevant notes)\n` +
    `Durable, project-specific knowledge. Treat it as authoritative — use it and do NOT contradict it. ` +
    `If you make a new durable decision or learn a lasting fact about this project, record it with the save_note tool.\n\n` +
    notes.map((n) => `## ${n.name}\n${n.content.trim()}`).join('\n\n')
  );
}

/** Number of notes relevant to a query (for a quick "pulled N notes" log). */
export function brainHitCount(cwd: string, query: string): number {
  return retrieveBrain(cwd, query).length;
}

/** Write/append a note to the vault. Returns the file path. */
export function saveBrainNote(cwd: string, title: string, content: string, mode: 'append' | 'replace' = 'append'): string {
  const dir = brainDir(cwd);
  mkdirSync(dir, { recursive: true });
  const safe = (title || 'notes').replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 60) || 'notes';
  const p = join(dir, `${safe}.md`);
  const body = content.trim();
  if (mode === 'append' && existsSync(p)) {
    appendFileSync(p, `\n\n${body}\n`);
  } else {
    writeFileSync(p, `# ${title}\n\n${body}\n`);
  }
  return p;
}
