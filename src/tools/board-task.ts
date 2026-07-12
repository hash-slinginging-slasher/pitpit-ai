import { tool } from '@openrouter/agent/tool';
import { z } from 'zod';
import {
  addTask,
  updateTask,
  deleteTask,
  getTask,
  completeTaskByTitle,
  loadBoard,
  type Task,
  type TaskStatus,
} from '../board.js';

/** Compact card shape returned to the model (detail trimmed so lists stay cheap). */
function card(t: Task, fullDetail = false) {
  return {
    id: t.id,
    title: t.title,
    status: t.status,
    by: t.by,
    detail: fullDetail ? t.detail : t.detail?.slice(0, 200),
  };
}

export const boardTaskTool = tool({
  name: 'board_task',
  description:
    'Read and manage the project Kanban board (.codigo/board.json) through this API — do NOT ' +
    'read, grep, or file_write that JSON directly. Columns are todo / pending (in-progress) / done. ' +
    'Actions: "list" returns the cards (optionally filtered by status); "get" returns one card by id; ' +
    '"add" creates a card; "update" patches a card by id (title/status/detail); "done" marks the ' +
    'newest card whose title matches Completed; "delete" removes a card by id.',
  inputSchema: z.object({
    action: z
      .enum(['list', 'get', 'add', 'update', 'done', 'delete'])
      .describe('list | get | add | update | done | delete'),
    id: z.string().optional().describe('card id — required for get / update / delete'),
    title: z
      .string()
      .optional()
      .describe('for "add": the card title; for "done": text to match an open card by; for "update": new title'),
    status: z
      .enum(['todo', 'pending', 'done'])
      .optional()
      .describe('for "add"/"update": the column; for "list": filter to this status only'),
    detail: z.string().optional().describe('for "add"/"update": longer description / notes'),
  }),
  execute: async ({ action, id, title, status, detail }) => {
    const cwd = process.cwd();
    try {
      switch (action) {
        case 'list': {
          const all = loadBoard(cwd).tasks;
          const counts = { todo: 0, pending: 0, done: 0 } as Record<TaskStatus, number>;
          for (const t of all) counts[t.status]++;
          const tasks = status ? all.filter((t) => t.status === status) : all;
          return { ok: true, counts, count: tasks.length, tasks: tasks.map((t) => card(t)) };
        }
        case 'get': {
          if (!id) return { ok: false, error: 'get requires an id' };
          const t = getTask(cwd, id);
          return t ? { ok: true, task: card(t, true) } : { ok: false, error: `no card with id ${id}` };
        }
        case 'add': {
          if (!title) return { ok: false, error: 'add requires a title' };
          const t = addTask(cwd, title, { status, detail, by: 'agent' });
          return { ok: true, id: t.id, status: t.status };
        }
        case 'update': {
          if (!id) return { ok: false, error: 'update requires an id' };
          const patch: Partial<Pick<Task, 'title' | 'detail' | 'status'>> = {};
          if (title !== undefined) patch.title = title;
          if (detail !== undefined) patch.detail = detail;
          if (status !== undefined) patch.status = status;
          if (!Object.keys(patch).length) return { ok: false, error: 'update needs at least one of title/status/detail' };
          const t = updateTask(cwd, id, patch);
          return t ? { ok: true, task: card(t, true) } : { ok: false, error: `no card with id ${id}` };
        }
        case 'done': {
          if (!title) return { ok: false, error: 'done requires a title to match' };
          const t = completeTaskByTitle(cwd, title);
          return t ? { ok: true, completed: t.title, id: t.id } : { ok: false, error: 'no matching open card' };
        }
        case 'delete': {
          if (!id) return { ok: false, error: 'delete requires an id' };
          if (!getTask(cwd, id)) return { ok: false, error: `no card with id ${id}` };
          deleteTask(cwd, id);
          return { ok: true, deleted: id };
        }
        default:
          return { ok: false, error: `unknown action ${action}` };
      }
    } catch (err: any) {
      return { ok: false, error: err?.message ?? String(err) };
    }
  },
});
