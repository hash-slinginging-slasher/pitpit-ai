import { tool } from '@openrouter/agent/tool';
import { z } from 'zod';
import { readFile, writeFile } from 'fs/promises';

export const fileEditTool = tool({
  name: 'file_edit',
  description:
    'Replace an exact string in a file with new text. The old_string must appear exactly once (include enough surrounding context to make it unique), otherwise the edit is rejected.',
  inputSchema: z.object({
    path: z.string().describe('Path to the file to edit'),
    old_string: z.string().describe('Exact text to find (must be unique in the file)'),
    new_string: z.string().describe('Text to replace it with'),
  }),
  execute: async ({ path, old_string, new_string }) => {
    try {
      const content = await readFile(path, 'utf-8');
      const count = content.split(old_string).length - 1;
      if (count === 0) return { error: 'old_string not found in file' };
      if (count > 1)
        return { error: `old_string appears ${count} times; add more surrounding context to make it unique` };
      await writeFile(path, content.replace(old_string, new_string), 'utf-8');
      return { ok: true, path };
    } catch (err: any) {
      if (err.code === 'ENOENT') return { error: `File not found: ${path}` };
      return { error: err.message };
    }
  },
});
