import { tool } from '@openrouter/agent/tool';
import { z } from 'zod';
import { readFile, writeFile } from 'fs/promises';
import { robustReplace } from './edit-util.js';

export const fileEditTool = tool({
  name: 'file_edit',
  description:
    'Replace an exact string in a file with new text. The old_string must appear exactly once (include enough surrounding context to make it unique), otherwise the edit is rejected. Line-ending and trailing-whitespace differences are tolerated automatically, but the text and indentation must otherwise match — if it is not found, re-read the file to copy the current text exactly.',
  inputSchema: z.object({
    path: z.string().describe('Path to the file to edit'),
    old_string: z.string().describe('Exact text to find (must be unique in the file)'),
    new_string: z.string().describe('Text to replace it with'),
  }),
  execute: async ({ path, old_string, new_string }) => {
    try {
      const content = await readFile(path, 'utf-8');
      const r = robustReplace(content, old_string, new_string);
      if (!r.ok) {
        if (r.reason === 'multiple')
          return { error: `old_string appears ${r.count} times; add more surrounding context to make it unique` };
        return {
          error: `old_string not found in file${r.hint ? '. ' + r.hint : ''}. Re-read the file with file_read and copy the exact current text (indentation matters).`,
        };
      }
      await writeFile(path, r.content, 'utf-8');
      return { ok: true, path };
    } catch (err: any) {
      if (err.code === 'ENOENT') return { error: `File not found: ${path}` };
      return { error: err.message };
    }
  },
});
