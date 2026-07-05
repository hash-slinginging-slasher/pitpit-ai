import { tool } from '@openrouter/agent/tool';
import { z } from 'zod';
import { readFile, writeFile } from 'fs/promises';

export const multiEditTool = tool({
  name: 'multi_edit',
  description:
    'Apply several find-and-replace edits to one file in a single call. Edits are applied in order; each old_string must occur exactly once at the time it is applied (include enough context to be unique). If any edit fails, nothing is written (atomic).',
  inputSchema: z.object({
    path: z.string().describe('Path to the file to edit'),
    edits: z
      .array(
        z.object({
          old_string: z.string().describe('Exact text to find (unique when applied)'),
          new_string: z.string().describe('Replacement text'),
        }),
      )
      .min(1)
      .describe('Ordered list of edits'),
  }),
  execute: async ({ path, edits }) => {
    try {
      let content = await readFile(path, 'utf-8');
      for (let i = 0; i < edits.length; i++) {
        const { old_string, new_string } = edits[i];
        const count = content.split(old_string).length - 1;
        if (count === 0) return { error: `Edit ${i + 1}: old_string not found` };
        if (count > 1) return { error: `Edit ${i + 1}: old_string appears ${count} times; add more context` };
        content = content.replace(old_string, new_string);
      }
      await writeFile(path, content, 'utf-8');
      return { ok: true, path, edits: edits.length };
    } catch (err: any) {
      if (err.code === 'ENOENT') return { error: `File not found: ${path}` };
      return { error: err.message };
    }
  },
});
