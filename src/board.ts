import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';

/**
 * Per-project Kanban board at `.codigo/board.json`. Three columns — todo / pending / done —
 * that the orchestrator maintains as a scrum master (a card per plan step, moved as it runs)
 * and that you manage in the Board tab. Versioned in git like the brain.
 */

export type TaskStatus = 'todo' | 'pending' | 'done';

export interface Task {
  id: string;
  title: string;
  detail?: string;
  status: TaskStatus;
  by?: string; // 'orchestrator' | 'you' | 'agent'
  created: number;
  updated: number;
}

export interface Board {
  tasks: Task[];
}

export function boardPath(cwd: string): string {
  return join(cwd, '.codigo', 'board.json');
}

export function loadBoard(cwd: string): Board {
  const p = boardPath(cwd);
  if (!existsSync(p)) return { tasks: [] };
  try {
    const raw = JSON.parse(readFileSync(p, 'utf-8'));
    return { tasks: Array.isArray(raw?.tasks) ? raw.tasks : [] };
  } catch {
    return { tasks: [] };
  }
}

export function saveBoard(cwd: string, board: Board): void {
  const p = boardPath(cwd);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ tasks: board.tasks ?? [] }, null, 2));
}

function genId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/** Add a task; returns it. */
export function addTask(cwd: string, title: string, opts?: { detail?: string; status?: TaskStatus; by?: string }): Task {
  const board = loadBoard(cwd);
  const now = Date.now();
  const task: Task = {
    id: genId(),
    title: title.slice(0, 200),
    detail: opts?.detail,
    status: opts?.status ?? 'todo',
    by: opts?.by ?? 'you',
    created: now,
    updated: now,
  };
  board.tasks.push(task);
  saveBoard(cwd, board);
  return task;
}

/** Patch a task by id (status/title/detail). No-op if not found. */
export function updateTask(cwd: string, id: string, patch: Partial<Pick<Task, 'title' | 'detail' | 'status'>>): Task | null {
  const board = loadBoard(cwd);
  const t = board.tasks.find((x) => x.id === id);
  if (!t) return null;
  Object.assign(t, patch, { updated: Date.now() });
  saveBoard(cwd, board);
  return t;
}

/** Mark the most recent matching-title task done (used by the board_task tool). */
export function completeTaskByTitle(cwd: string, title: string): Task | null {
  const board = loadBoard(cwd);
  const t = [...board.tasks].reverse().find((x) => x.status !== 'done' && x.title.toLowerCase().includes(title.toLowerCase()));
  if (!t) return null;
  t.status = 'done';
  t.updated = Date.now();
  saveBoard(cwd, board);
  return t;
}

export function deleteTask(cwd: string, id: string): void {
  const board = loadBoard(cwd);
  board.tasks = board.tasks.filter((x) => x.id !== id);
  saveBoard(cwd, board);
}
