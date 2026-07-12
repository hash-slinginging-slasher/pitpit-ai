import { tool } from '@openrouter/agent/tool';
import { z } from 'zod';
import { saveBrainNote } from '../brain.js';

export const brainNoteTool = tool({
  name: 'save_note',
  description:
    "Save a durable note to the project brain (.codigo/brain/) so future sessions and other agents remember it. " +
    'Use it for lasting facts: architecture, key decisions and WHY, gotchas, conventions, glossary, or important TODOs — ' +
    'NOT for transient chatter or step-by-step progress. Keep notes concise. Organize with folders in the title ' +
    '(e.g. "decisions/rate-limits", "architecture/db", "gotchas/webhooks"). Prefer appending to an existing note ' +
    'over creating many tiny ones. Link related notes inline with [[folder/name]].',
  inputSchema: z.object({
    title: z
      .string()
      .describe('Note path/name; may include folders, e.g. "architecture/db", "decisions/rate-limits", "gotchas".'),
    content: z.string().describe('The note body in markdown. Durable and to the point.'),
    mode: z
      .enum(['append', 'replace'])
      .optional()
      .describe('append (default) adds to an existing note of this title; replace overwrites it.'),
  }),
  execute: async ({ title, content, mode }) => {
    try {
      const path = saveBrainNote(process.cwd(), title, content, mode || 'append');
      return { saved: true, path };
    } catch (err: any) {
      return { error: err?.message ?? String(err) };
    }
  },
});
