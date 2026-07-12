import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, appendFileSync } from 'fs';
import { join, dirname } from 'path';
import { embeddingModel } from './config.js';
import { embeddingsEnabled, embedTexts, embedOne, cosine } from './embeddings.js';

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

/** Folder holding raw dropped attachments (not treated as notes). */
export const ATTACH_DIR = '_attachments';

/** Load every note in the vault, recursing subfolders. A note's `name` is its path
 * relative to the brain dir (e.g. "decisions/rate-limits"). Missing dir → []. */
export function loadBrain(cwd: string): BrainNote[] {
  const dir = brainDir(cwd);
  if (!existsSync(dir)) return [];
  const out: BrainNote[] = [];
  const walk = (d: string, prefix: string, depth: number) => {
    if (depth > 8) return;
    let entries: import('fs').Dirent[];
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === ATTACH_DIR) continue; // skip hidden + raw attachments
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      const full = join(d, e.name);
      if (e.isDirectory()) {
        walk(full, rel, depth + 1);
      } else if (/\.md$/i.test(e.name) && !/^readme\.md$/i.test(e.name)) {
        try {
          out.push({ name: rel.replace(/\.md$/i, ''), content: readFileSync(full, 'utf-8'), path: full });
        } catch {
          /* skip unreadable */
        }
      }
    }
  };
  walk(dir, '', 0);
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
export function retrieveBrainKeyword(
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

// ---- Semantic retrieval (embeddings + in-process cosine, cached per project) ----

interface Chunk { id: string; note: string; text: string; hash: string; }
interface EmbedCache { model: string; vectors: Record<string, { hash: string; v: number[] }> }

function hashStr(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
/** Split a note into `##`-heading sections (whole note if it has none). */
function splitSections(md: string): string[] {
  const lines = md.split(/\r?\n/);
  const secs: string[] = [];
  let cur: string[] = [];
  for (const l of lines) {
    if (/^##\s/.test(l) && cur.some((x) => x.trim())) { secs.push(cur.join('\n')); cur = [l]; }
    else cur.push(l);
  }
  if (cur.some((x) => x.trim())) secs.push(cur.join('\n'));
  return secs.length ? secs : [md];
}
function chunkNotes(notes: BrainNote[]): Chunk[] {
  const chunks: Chunk[] = [];
  for (const n of notes) {
    splitSections(n.content).forEach((sec, i) => {
      const body = sec.trim();
      if (!body) return;
      const text = `${n.name}: ${body}`.slice(0, 3000);
      chunks.push({ id: `${n.name}#${i}`, note: n.name, text, hash: hashStr(text) });
    });
  }
  return chunks;
}

async function retrieveBrainSemantic(
  cwd: string,
  query: string,
  opts?: { maxNotes?: number; totalChars?: number },
): Promise<BrainNote[]> {
  const notes = loadBrain(cwd);
  if (!notes.length) return [];
  const chunks = chunkNotes(notes);
  if (!chunks.length) return [];
  const model = embeddingModel();

  const cachePath = join(brainDir(cwd), '.embeddings.json');
  let cache: EmbedCache = { model, vectors: {} };
  try {
    const raw = JSON.parse(readFileSync(cachePath, 'utf-8'));
    if (raw && raw.model === model && raw.vectors) cache = raw;
  } catch {
    /* no/invalid cache → rebuild */
  }

  // Embed any new or changed chunks; prune vanished ones.
  const need = chunks.filter((c) => cache.vectors[c.id]?.hash !== c.hash);
  if (need.length) {
    const vecs = await embedTexts(need.map((c) => c.text));
    need.forEach((c, i) => { cache.vectors[c.id] = { hash: c.hash, v: vecs[i] }; });
    const valid = new Set(chunks.map((c) => c.id));
    for (const id of Object.keys(cache.vectors)) if (!valid.has(id)) delete cache.vectors[id];
    cache.model = model;
    try { mkdirSync(brainDir(cwd), { recursive: true }); writeFileSync(cachePath, JSON.stringify(cache)); } catch { /* cache is best-effort */ }
  }

  const qv = await embedOne(query);
  const scored = chunks
    .map((c) => ({ c, score: cosine(qv, cache.vectors[c.id]?.v || []) }))
    .filter((x) => x.score >= 0.2) // relevance floor (embedding-model dependent; tunable)
    .sort((a, b) => b.score - a.score);

  const maxNotes = opts?.maxNotes ?? 5;
  const totalChars = opts?.totalChars ?? 7000;
  const out: BrainNote[] = [];
  let total = 0;
  for (const { c } of scored.slice(0, maxNotes)) {
    if (total + c.text.length > totalChars) break;
    total += c.text.length;
    out.push({ name: c.note, content: c.text, path: '' });
  }
  return out;
}

/**
 * Retrieve the brain notes most relevant to `query`. Uses semantic (embedding) search when
 * an embedding model is configured; falls back to keyword retrieval otherwise or on error.
 */
export async function retrieveBrain(
  cwd: string,
  query: string,
  opts?: { maxNotes?: number; totalChars?: number },
): Promise<BrainNote[]> {
  if (embeddingsEnabled()) {
    try {
      const notes = await retrieveBrainSemantic(cwd, query, opts);
      if (notes.length) return notes;
    } catch {
      /* embedding provider failed → keyword fallback */
    }
  }
  return retrieveBrainKeyword(cwd, query, opts);
}

/** Format retrieved notes into an injectable context block ('' if none). */
export function formatBrainContext(notes: BrainNote[]): string {
  if (!notes.length) return '';
  return (
    `# Project brain (relevant notes)\n` +
    `Durable, project-specific knowledge. Treat it as authoritative — use it and do NOT contradict it. ` +
    `If you make a new durable decision or learn a lasting fact about this project, record it with the save_note tool.\n\n` +
    notes.map((n) => `## ${n.name}\n${n.content.trim()}`).join('\n\n')
  );
}

/** Formatted brain context for injection, or '' if no relevant notes. */
export async function brainContext(cwd: string, query: string): Promise<string> {
  return formatBrainContext(await retrieveBrain(cwd, query));
}

/** Sanitize a note title/path into a safe relative path (folders allowed via "/"). */
export function safeNotePath(title: string): string {
  const rel = (title || 'notes')
    .split('/')
    .map((seg) => seg.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 60))
    .filter(Boolean)
    .join('/');
  return rel || 'notes';
}

/** Write/append a note to the vault. The title may include folders (e.g. "decisions/x"),
 * which are created automatically. Returns the file path. */
export function saveBrainNote(cwd: string, title: string, content: string, mode: 'append' | 'replace' = 'append'): string {
  const rel = safeNotePath(title);
  const p = join(brainDir(cwd), `${rel}.md`);
  mkdirSync(dirname(p), { recursive: true });
  const body = content.trim();
  if (mode === 'append' && existsSync(p)) {
    appendFileSync(p, `\n\n${body}\n`);
  } else {
    writeFileSync(p, `# ${rel.split('/').pop()}\n\n${body}\n`);
  }
  return p;
}
