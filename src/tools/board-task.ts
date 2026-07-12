import { tool } from '@openrouter/agent/tool';
import { z } from 'zod';
import { addTask, completeTaskByTitle } from '../board.js';

export const boardTaskTool = tool({
  name: 'board_task',
  description:
    'Track work on the project Kanban board (.codigo/board.json). action "add" creates a card ' +
    '(To Do by default); action "done" marks the newest matching card Completed. Use for meaningful ' +
    'work items the user would want to see tracked — not trivial steps.',
  inputSchema: z.object({
    action: z.enum(['add', 'done']).describe('add a card, or mark a matching card done'),
    title: z.string().describe('Card title (for "done", used to find the card by matching text)'),
    status: z.enum(['todo', 'pending', 'done']).optional().describe('for "add": column (default todo)'),
    detail: z.string().optional().describe('for "add": optional description'),
  }),
  execute: async ({ action, title, status, detail }) => {
    try {
      if (action === 'done') {
        const t = completeTaskByTitle(process.cwd(), title);
        return t ? { ok: true, completed: t.title } : { ok: false, error: 'no matching open task' };
      }
      const t = addTask(process.cwd(), title, { status, detail, by: 'agent' });
      return { ok: true, id: t.id, status: t.status };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? String(err) };
    }
  },
});
