import { tool } from '@openrouter/agent/tool';
import { z } from 'zod';
import { retrieveDeps, buildDepsIndex, indexedPackages } from '../depsdocs.js';

/**
 * Offline docs for the project's own installed dependencies (README + types, straight from
 * node_modules). No network — complements docs_lookup (Context7), and works for the exact
 * installed versions and for private/unpublished libraries Context7 doesn't have.
 */

export const depsDocsTool = tool({
  name: 'deps_docs',
  description:
    "Search the OFFLINE documentation of THIS project's installed dependencies (from node_modules: " +
    'README + TypeScript types, for the exact installed versions). Use it to check a dependency\'s ' +
    'real API/usage before writing code against it. Give a natural-language query, optionally ' +
    'scoped to one package. Fully local — no network. (For libraries not installed here, use docs_lookup.)',
  inputSchema: z.object({
    query: z.string().describe('What you want to know, e.g. "create a websocket server" or "zod object schema".'),
    library: z.string().optional().describe('Restrict the search to one installed package (e.g. "ws", "zod").'),
    refresh: z.boolean().optional().describe('Rebuild the index from node_modules first (use after installing new deps).'),
  }),
  execute: async ({ query, library, refresh }) => {
    const cwd = process.cwd();
    try {
      if (refresh) {
        const b = await buildDepsIndex(cwd);
        if (!b.hasNodeModules) return { ok: false, error: 'No node_modules here — install dependencies first (npm install).' };
      }
      let hits = await retrieveDeps(cwd, query, { library, k: 5 });
      if (hits === null) {
        // No index yet → build it once, then retrieve.
        const b = await buildDepsIndex(cwd);
        if (!b.hasNodeModules) return { ok: false, error: 'No node_modules here — this tool indexes an installed Node project. Use docs_lookup for other libraries.' };
        if (!b.chunks) return { ok: false, error: 'No documentation found in the installed dependencies.' };
        hits = (await retrieveDeps(cwd, query, { library, k: 5 })) ?? [];
      }
      if (!hits.length) {
        const avail = indexedPackages(cwd).map((p) => p.pkg);
        return {
          ok: true,
          hits: [],
          note: library
            ? `No matches in "${library}".`
            : 'No matches. Indexed packages: ' + (avail.slice(0, 40).join(', ') || '(none)'),
        };
      }
      return {
        ok: true,
        hits: hits.map((h) => ({ package: `${h.pkg}@${h.version}`, excerpt: h.text })),
      };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? String(err) };
    }
  },
});
