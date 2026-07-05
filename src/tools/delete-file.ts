import { tool } from '@openrouter/agent/tool';
import { z } from 'zod';
import { rm, stat } from 'fs/promises';
import { resolve, parse } from 'path';

export const deleteFileTool = tool({
  name: 'delete_file',
  description:
    'Delete a file (cross-platform — no shell needed). To delete a directory and its contents, pass recursive: true. Refuses to delete a filesystem root or the current working directory.',
  inputSchema: z.object({
    path: z.string().describe('Path to the file or directory to delete'),
    recursive: z.boolean().optional().describe('Required (true) to delete a non-empty directory'),
  }),
  execute: async ({ path, recursive }) => {
    if (!path.trim()) return { error: 'path is required' };
    const abs = resolve(path);

    // Guardrails: never delete a drive/filesystem root or the working directory.
    if (abs === parse(abs).root) return { error: `Refusing to delete filesystem root: ${abs}` };
    if (abs === resolve(process.cwd())) return { error: 'Refusing to delete the current working directory' };

    try {
      const info = await stat(abs);
      if (info.isDirectory() && !recursive) {
        return { error: `${path} is a directory. Pass recursive: true to delete it and its contents.` };
      }
      await rm(abs, { recursive: !!recursive, force: false });
      return { ok: true, path: abs, kind: info.isDirectory() ? 'directory' : 'file' };
    } catch (err: any) {
      if (err.code === 'ENOENT') return { error: `Not found: ${path}` };
      if (err.code === 'EACCES' || err.code === 'EPERM') return { error: `Permission denied: ${path}` };
      if (err.code === 'ENOTEMPTY') return { error: `Directory not empty: ${path} (pass recursive: true)` };
      return { error: err.message };
    }
  },
});
