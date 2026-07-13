import { readFileSync, existsSync, readdirSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { embeddingModel } from './config.js';
import { embeddingsEnabled, embedTexts, embedOne, cosine } from './embeddings.js';

/**
 * Offline documentation index for a project's DIRECT dependencies. Everything is sourced
 * from what already ships on disk in the installed packages — README, package.json
 * description/keywords, and the package's TypeScript declaration file (exact API for the
 * installed version) — so building and querying it needs no network at all. Retrieval is
 * semantic when an embedding model is configured (ideally a local one) and falls back to
 * keyword scoring otherwise, so it works fully offline either way.
 *
 * Cache lives at `.codigo/docs-index.json` (derived, not curated knowledge — gitignored,
 * unlike the brain). Rebuilds incrementally: only chunks whose text changed are re-embedded.
 */

const CACHE_DIR = '.codigo/cache';
const INDEX_FILE = `${CACHE_DIR}/docs-index.json`;
const PER_PKG_CHARS = 8000; // cap doc text gathered per package
const PER_TYPES_CHARS = 3500; // cap the .d.ts excerpt (type files can be huge)
const CHUNK_CHARS = 1400;

export interface DepChunk {
  id: string; // `${pkg}#${i}`
  pkg: string;
  version: string;
  text: string;
  hash: string;
}
interface DepsIndex {
  model: string; // embedding model the vectors were built with ('' = none/keyword-only)
  updated: number;
  chunks: DepChunk[];
  vectors: Record<string, { v: number[]; hash: string }>;
}

export function indexPath(cwd: string): string {
  return join(cwd, INDEX_FILE);
}

function hashStr(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i);
  return (h >>> 0).toString(36);
}
function tokenize(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9_.-]{2,}/g) ?? []).filter((t) => t.length < 40);
}

/** Read a package's README (first matching filename), or ''. */
function readReadme(dir: string): string {
  for (const name of ['README.md', 'readme.md', 'README.markdown', 'README', 'readme']) {
    const p = join(dir, name);
    if (existsSync(p)) {
      try {
        return readFileSync(p, 'utf-8');
      } catch {
        /* ignore */
      }
    }
  }
  return '';
}

/** Gather offline doc text for one installed package (README + metadata + types excerpt). */
function extractPkgDoc(dir: string, name: string): { version: string; text: string } | null {
  const pkgJsonPath = join(dir, 'package.json');
  if (!existsSync(pkgJsonPath)) return null;
  let meta: any = {};
  try {
    meta = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
  } catch {
    return null;
  }
  const version = String(meta.version ?? '?');
  const parts: string[] = [`# ${name}@${version}`];
  if (meta.description) parts.push(String(meta.description));
  if (Array.isArray(meta.keywords) && meta.keywords.length) parts.push('keywords: ' + meta.keywords.join(', '));

  const readme = readReadme(dir);
  if (readme) parts.push(readme);

  // The declaration file is exact, version-accurate API surface — very high signal.
  const typesRel = meta.types || meta.typings;
  if (typesRel) {
    const typesPath = join(dir, String(typesRel));
    if (existsSync(typesPath)) {
      try {
        const dts = readFileSync(typesPath, 'utf-8');
        parts.push(`\n--- types (${typesRel}) ---\n` + dts.slice(0, PER_TYPES_CHARS));
      } catch {
        /* ignore */
      }
    }
  }
  const text = parts.join('\n\n').slice(0, PER_PKG_CHARS).trim();
  return text ? { version, text } : null;
}

/** Direct dependencies declared in package.json that are actually installed in node_modules. */
function discoverDeps(cwd: string): { name: string; dir: string }[] {
  const pkgJson = join(cwd, 'package.json');
  if (!existsSync(pkgJson)) return [];
  let meta: any = {};
  try {
    meta = JSON.parse(readFileSync(pkgJson, 'utf-8'));
  } catch {
    return [];
  }
  const names = new Set<string>([
    ...Object.keys(meta.dependencies ?? {}),
    ...Object.keys(meta.devDependencies ?? {}),
  ]);
  const out: { name: string; dir: string }[] = [];
  for (const name of names) {
    const dir = join(cwd, 'node_modules', name); // works for scoped names too (@scope/pkg)
    if (existsSync(dir)) out.push({ name, dir });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function chunkText(pkg: string, version: string, text: string): DepChunk[] {
  const chunks: DepChunk[] = [];
  for (let i = 0, n = 0; i < text.length; i += CHUNK_CHARS, n++) {
    const body = text.slice(i, i + CHUNK_CHARS);
    const withCtx = `${pkg}: ${body}`;
    chunks.push({ id: `${pkg}#${n}`, pkg, version, text: withCtx, hash: hashStr(withCtx) });
  }
  return chunks;
}

function loadIndex(cwd: string): DepsIndex | null {
  const p = indexPath(cwd);
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, 'utf-8'));
    if (!Array.isArray(raw?.chunks)) return null;
    return { model: raw.model ?? '', updated: raw.updated ?? 0, chunks: raw.chunks, vectors: raw.vectors ?? {} };
  } catch {
    return null;
  }
}

function saveIndex(cwd: string, idx: DepsIndex): void {
  const p = indexPath(cwd);
  const dir = dirname(p);
  mkdirSync(dir, { recursive: true });
  // Derived cache — keep it out of git in whatever project the agent is operating on.
  const ignore = join(dir, '.gitignore');
  if (!existsSync(ignore)) {
    try {
      writeFileSync(ignore, '*\n');
    } catch {
      /* best-effort */
    }
  }
  writeFileSync(p, JSON.stringify(idx));
}

export interface BuildResult {
  packages: number;
  chunks: number;
  embedded: number;
  hasNodeModules: boolean;
}

/**
 * Build (or incrementally refresh) the dep-docs index from installed packages. Embeds
 * new/changed chunks only when an embedding model is configured; otherwise stores text for
 * keyword retrieval. Fully offline except the optional embedding call.
 */
export async function buildDepsIndex(cwd: string, signal?: AbortSignal): Promise<BuildResult> {
  const deps = discoverDeps(cwd);
  const hasNodeModules = existsSync(join(cwd, 'node_modules'));
  const chunks: DepChunk[] = [];
  for (const { name, dir } of deps) {
    const doc = extractPkgDoc(dir, name);
    if (doc) chunks.push(...chunkText(name, doc.version, doc.text));
  }

  const model = embeddingModel() || '';
  const prev = loadIndex(cwd);
  // Reuse cached vectors whose text is unchanged AND were built with the same model.
  const vectors: DepsIndex['vectors'] = {};
  if (prev && prev.model === model) {
    for (const c of chunks) {
      const cached = prev.vectors[c.id];
      if (cached && cached.hash === c.hash) vectors[c.id] = cached;
    }
  }

  let embedded = 0;
  if (model && embeddingsEnabled() && chunks.length) {
    const need = chunks.filter((c) => vectors[c.id]?.hash !== c.hash);
    if (need.length) {
      try {
        const vecs = await embedTexts(need.map((c) => c.text), signal);
        need.forEach((c, i) => {
          if (Array.isArray(vecs[i])) vectors[c.id] = { v: vecs[i], hash: c.hash };
        });
        embedded = need.length;
      } catch {
        /* embedding provider unavailable/offline → keep text for keyword retrieval */
      }
    }
  }

  saveIndex(cwd, { model, updated: Date.now(), chunks, vectors });
  return { packages: deps.length, chunks: chunks.length, embedded, hasNodeModules };
}

export interface DepHit {
  pkg: string;
  version: string;
  text: string;
  score: number;
}

/** Keyword scoring: term overlap on the chunk text, with a boost for the package name. */
function keywordRank(chunks: DepChunk[], query: string, library?: string): DepHit[] {
  const q = new Set(tokenize(query));
  const lib = library?.toLowerCase();
  return chunks
    .map((c) => {
      if (lib && !c.pkg.toLowerCase().includes(lib)) return { c, score: 0 };
      let score = 0;
      for (const t of tokenize(c.text)) if (q.has(t)) score++;
      for (const t of tokenize(c.pkg)) if (q.has(t)) score += 4; // name match is a strong signal
      return { c, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((x) => ({ pkg: x.c.pkg, version: x.c.version, text: x.c.text, score: x.score }));
}

/**
 * Retrieve the dep-doc chunks most relevant to `query` (optionally within one library).
 * Semantic when embeddings are available, keyword otherwise or on failure. Returns null if
 * the index hasn't been built yet (caller may build it and retry).
 */
export async function retrieveDeps(
  cwd: string,
  query: string,
  opts?: { library?: string; k?: number; signal?: AbortSignal },
): Promise<DepHit[] | null> {
  const idx = loadIndex(cwd);
  if (!idx) return null;
  const k = opts?.k ?? 5;
  const lib = opts?.library?.toLowerCase();
  const pool = lib ? idx.chunks.filter((c) => c.pkg.toLowerCase().includes(lib)) : idx.chunks;
  if (!pool.length) return [];

  const haveVectors = idx.model && embeddingsEnabled() && pool.some((c) => idx.vectors[c.id]);
  if (haveVectors) {
    try {
      const qv = await embedOne(query, opts?.signal);
      const scored = pool
        .map((c) => ({ c, score: cosine(qv, idx.vectors[c.id]?.v || []) }))
        .filter((x) => x.score >= 0.2)
        .sort((a, b) => b.score - a.score);
      if (scored.length) {
        return scored.slice(0, k).map((x) => ({ pkg: x.c.pkg, version: x.c.version, text: x.c.text, score: x.score }));
      }
      // Nothing cleared the relevance floor → fall through to keyword.
    } catch {
      /* embedding failed (offline) → keyword fallback */
    }
  }
  return keywordRank(pool, query, opts?.library).slice(0, k);
}

/** List the packages currently represented in the index (name@version). */
export function indexedPackages(cwd: string): { pkg: string; version: string }[] {
  const idx = loadIndex(cwd);
  if (!idx) return [];
  const seen = new Map<string, string>();
  for (const c of idx.chunks) if (!seen.has(c.pkg)) seen.set(c.pkg, c.version);
  return [...seen.entries()].map(([pkg, version]) => ({ pkg, version }));
}
