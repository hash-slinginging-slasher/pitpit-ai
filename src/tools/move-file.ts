import { tool } from '@openrouter/agent/tool';
import { z } from 'zod';
import { rename, mkdir, cp, rm } from 'fs/promises';
import { dirname } from 'path';

export const moveFileTool = tool({
  name: 'move_file',
  description:
    'Move or rename a file or directory. Parent directories of the destination are created automatically.',
  inputSchema: z.object({
    from: z.string().describe('Source path'),
    to: z.string().describe('Destination path'),
  }),
  execute: async ({ from, to }) => {
    if (!from.trim() || !to.trim()) return { error: 'from and to are required' };
    try {
      await mkdir(dirname(to), { recursive: true });
      try {
        await rename(from, to);
      } catch (err: any) {
        // rename fails across drives/volumes (EXDEV) — fall back to copy + delete.
        if (err.code !== 'EXDEV') throw err;
        await cp(from, to, { recursive: true, force: true });
        await rm(from, { recursive: true, force: true });
      }
      return { ok: true, from, to };
    } catch (err: any) {
      if (err.code === 'ENOENT') return { error: `Source not found: ${from}` };
      return { error: err.message };
    }
  },
});
