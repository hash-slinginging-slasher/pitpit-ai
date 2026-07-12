import { tool } from '@openrouter/agent/tool';
import { z } from 'zod';
import { writeFile, mkdir } from 'fs/promises';
import { dirname } from 'path';

export const fileWriteTool = tool({
  name: 'file_write',
  description:
    'Write content to a file, creating it (and any parent directories) if needed. Overwrites the file if it already exists. PREFER this for creating a file or rewriting most of a small file (~under 200 lines) — it is simpler and more reliable than find-and-replace. Use file_edit/multi_edit only for a few targeted changes to a large file you should not resend in full.',
  inputSchema: z.object({
    path: z.string().describe('Path to the file to write'),
    content: z.string().describe('Full content to write to the file'),
  }),
  execute: async ({ path, content }) => {
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content, 'utf-8');
      return { ok: true, path, bytes: Buffer.byteLength(content, 'utf-8') };
    } catch (err: any) {
      return { error: err.message };
    }
  },
});
