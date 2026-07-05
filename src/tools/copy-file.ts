import { tool } from '@openrouter/agent/tool';
import { z } from 'zod';
import { cp, mkdir, stat } from 'fs/promises';
import { dirname } from 'path';

export const copyFileTool = tool({
  name: 'copy_file',
  description:
    'Copy a file or directory to a new location. Parent directories of the destination are created automatically. Directories are copied recursively.',
  inputSchema: z.object({
    from: z.string().describe('Source path'),
    to: z.string().describe('Destination path'),
    overwrite: z.boolean().optional().describe('Overwrite the destination if it exists (default false)'),
  }),
  execute: async ({ from, to, overwrite }) => {
    if (!from.trim() || !to.trim()) return { error: 'from and to are required' };
    try {
      const info = await stat(from);
      await mkdir(dirname(to), { recursive: true });
      await cp(from, to, { recursive: info.isDirectory(), force: !!overwrite, errorOnExist: !overwrite });
      return { ok: true, from, to, kind: info.isDirectory() ? 'directory' : 'file' };
    } catch (err: any) {
      if (err.code === 'ENOENT') return { error: `Source not found: ${from}` };
      if (err.code === 'ERR_FS_CP_EEXIST' || err.code === 'EEXIST')
        return { error: `Destination exists: ${to} (pass overwrite: true)` };
      return { error: err.message };
    }
  },
});
