import { tool } from '@openrouter/agent/tool';
import { z } from 'zod';
import { readdir } from 'fs/promises';

export const listDirTool = tool({
  name: 'list_dir',
  description: 'List the entries in a directory. Directories are suffixed with a trailing slash.',
  inputSchema: z.object({
    path: z.string().optional().describe('Directory to list (default: current working directory)'),
  }),
  execute: async ({ path }) => {
    const dir = path ?? process.cwd();
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      const names = entries
        .map((e) => (e.isDirectory() ? e.name + '/' : e.name))
        .sort((a, b) => a.localeCompare(b));
      return { path: dir, entries: names, count: names.length };
    } catch (err: any) {
      if (err.code === 'ENOENT') return { error: `Directory not found: ${dir}` };
      return { error: err.message };
    }
  },
});
