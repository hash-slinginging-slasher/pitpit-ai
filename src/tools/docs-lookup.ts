import { tool } from '@openrouter/agent/tool';
import { z } from 'zod';

/**
 * Current, version-specific library documentation via Context7's public REST API.
 * Lets a coder check the real package name / imports / API signatures before writing
 * code against a library, instead of guessing from stale training data.
 *
 *   resolve:  GET https://context7.com/api/v1/search?query=<name>  -> { results: [{ id, title, … }] }
 *   docs:     GET https://context7.com/api/v1/<id>?type=txt&topic=<t>&tokens=<n>  -> plain-text docs
 *
 * No key required; CONTEXT7_API_KEY (env) is optional for higher rate limits.
 */

const BASE = 'https://context7.com/api/v1';
const MAX_DOC_CHARS = 12000;

function c7fetch(url: string, signal: AbortSignal): Promise<Response> {
  const headers: Record<string, string> = { 'User-Agent': 'openrouter-coding-agent/0.1 (+docs_lookup)' };
  const key = process.env.CONTEXT7_API_KEY;
  if (key) headers.Authorization = `Bearer ${key}`;
  return fetch(url, { signal, headers });
}

const stripSlash = (s: string) => String(s || '').replace(/^\/+/, '');

export const docsLookupTool = tool({
  name: 'docs_lookup',
  description:
    'Look up CURRENT, version-specific documentation for a library or framework via Context7. ' +
    'Use this BEFORE writing code against a library whose exact package name, imports, or API you ' +
    'are unsure about — do not guess from memory. Give a library name (e.g. "next.js") and an ' +
    'optional topic (e.g. "routing"); it returns real doc snippets. Resolves the name to a doc set ' +
    'automatically, or pass an exact Context7 id like "vercel/next.js".',
  inputSchema: z.object({
    library: z.string().describe('Library/framework name (e.g. "react", "next.js", "zod") or an exact Context7 id like "vercel/next.js".'),
    topic: z.string().optional().describe('Focus area to filter the docs (e.g. "routing", "hooks", "authentication").'),
    tokens: z.number().optional().describe('Approx max doc tokens to return (default 4000, capped at 12000).'),
  }),
  execute: async ({ library, topic, tokens }) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      let id = stripSlash(library.trim());
      let resolved: { id: string; title?: string; trustScore?: number };
      let alternatives: string[] = [];

      // A bare name (no "owner/repo" slash) must be resolved to a Context7 library id first.
      if (!id.includes('/')) {
        const r = await c7fetch(`${BASE}/search?query=${encodeURIComponent(library)}`, controller.signal);
        if (!r.ok) return { error: `Context7 search failed: HTTP ${r.status} ${r.statusText}` };
        const j: any = await r.json().catch(() => ({}));
        const results: any[] = Array.isArray(j?.results) ? j.results : [];
        if (!results.length) return { error: `No library matched "${library}" on Context7.` };
        // Results come back best-first (score-sorted).
        id = stripSlash(results[0].id);
        if (!id) return { error: `Context7 returned no id for "${library}".` };
        resolved = { id, title: results[0].title, trustScore: results[0].trustScore };
        alternatives = results.slice(1, 5).map((x) => stripSlash(x.id)).filter(Boolean);
      } else {
        resolved = { id };
      }

      const tok = Math.min(Math.max(Number(tokens) || 4000, 500), 12000);
      let url = `${BASE}/${id}?type=txt&tokens=${tok}`;
      if (topic) url += `&topic=${encodeURIComponent(topic)}`;
      const dr = await c7fetch(url, controller.signal);
      if (!dr.ok) {
        return { error: `Context7 docs fetch failed for "${id}": HTTP ${dr.status} ${dr.statusText}`, ...(alternatives.length && { alternatives }) };
      }
      let docs = (await dr.text()).trim();
      if (!docs || /^(no content available|not found)/i.test(docs)) {
        return { error: `No docs returned for "${id}"${topic ? ` on topic "${topic}"` : ''}.`, ...(alternatives.length && { alternatives }) };
      }
      const truncated = docs.length > MAX_DOC_CHARS;
      if (truncated) docs = docs.slice(0, MAX_DOC_CHARS) + '\n…[truncated]';
      return {
        library: resolved,
        topic: topic ?? null,
        docs,
        ...(truncated && { truncated: true }),
        ...(alternatives.length && { alternatives }),
      };
    } catch (err: any) {
      if (err?.name === 'AbortError') return { error: `Context7 lookup timed out for "${library}".` };
      return { error: err?.message ?? String(err) };
    } finally {
      clearTimeout(timer);
    }
  },
});
