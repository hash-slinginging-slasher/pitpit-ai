import { tool } from '@openrouter/agent/tool';
import { z } from 'zod';
import { mkdir } from 'fs/promises';

export const makeDirTool = tool({
  name: 'make_dir',
  description: 'Create a directory, including any missing parent directories. No error if it already exists.',
  inputSchema: z.object({
    path: z.string().describe('Directory path to create'),
  }),
  execute: async ({ path }) => {
    if (!path.trim()) return { error: 'path is required' };
    try {
      await mkdir(path, { recursive: true });
      return { ok: true, path };
    } catch (err: any) {
      return { error: err.message };
    }
  },
});
