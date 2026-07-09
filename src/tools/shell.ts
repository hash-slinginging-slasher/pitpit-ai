import { tool } from '@openrouter/agent/tool';
import { z } from 'zod';
import { exec } from 'child_process';
import { promisify } from 'util';

// Use exec (not execFile) so the whole command is handed to the shell as a single
// string. execFile on Windows re-quotes each arg, which double-escapes quotes inside
// the command and mangles paths that contain spaces (e.g. `python "C:\a b\x.py"`).
const execAsync = promisify(exec);

const isWin = process.platform === 'win32';

/**
 * Approval gate. The CLI sets this to an interactive prompt so the user can
 * approve/deny each command. If left unset (e.g. headless benchmark runs),
 * commands are auto-approved.
 */
export type ApprovalFn = (command: string) => Promise<boolean>;
let approve: ApprovalFn = async () => true;
export function setShellApproval(fn: ApprovalFn) {
  approve = fn;
}

/**
 * Commands that launch an interactive UI, a REPL, or a never-exiting server. Run in
 * the captured (non-TTY) shell they just hang until the timeout, so we return a note
 * instead. Heuristic + conservative — anchored to command position to avoid matching
 * substrings of unrelated names.
 */
const INTERACTIVE_PATTERNS: { re: RegExp; why: string }[] = [
  { re: /(^|[\s&|;(])(vim?|nvim|nano|emacs|pico)\b/i, why: 'opens an interactive editor' },
  { re: /(^|[\s&|;(])(less|more)\b/i, why: 'opens an interactive pager' },
  { re: /(^|[\s&|;(])(top|htop|btop)\b/i, why: 'is a full-screen live monitor' },
  { re: /(^|[\s&|;(])tail\s+(-\S*\s+)*-\S*f/i, why: 'follows a file forever (tail -f)' },
  { re: /(^|[\s&|;(])watch\s+\S/i, why: 'reruns forever (watch)' },
  { re: /(^|[\s&|;(])git\s+\w+.*\B(-i|--interactive)\b/i, why: 'is an interactive git command' },
  { re: /(^|[\s&|;(])git\s+commit\b(?![^\n]*(-m|-F|--message|--file|--amend|--no-edit))/i, why: 'opens an editor for the commit message (add -m)' },
  { re: /(^|[\s&|;(])(ssh|telnet|ftp|sftp)\s+\S/i, why: 'opens an interactive remote session' },
  { re: /(^|[\s&|;(])(npm|yarn|pnpm|bun)\s+(run\s+)?(dev|start|serve|watch)\b/i, why: 'starts a long-running dev server' },
  { re: /(^|[\s&|;(])(vite|nodemon)\b/i, why: 'starts a long-running dev server' },
  { re: /(^|[\s&|;(])(webpack\s+serve|astro\s+dev)\b/i, why: 'starts a long-running dev server' },
  { re: /(^|[\s&|;(])(next\s+dev|ng\s+serve|flask\s+run|uvicorn|gunicorn|rails\s+s(erver)?\b|php\s+-S)/i, why: 'starts a long-running server' },
  { re: /(^|[\s&|;(])python\d?\s+-m\s+http\.server\b/i, why: 'starts a long-running HTTP server' },
  { re: /(^|[\s&|;(])(python\d?|node|deno|irb|ghci|psql|mysql|sqlite3|mongosh?|redis-cli)\s*$/i, why: 'launches an interactive REPL' },
  { re: /(^|[\s&|;(])(pause|read)\b/i, why: 'waits for a keypress / input' },
];

/** Reason the command looks interactive/long-running, or null. Skipped when the user
 * explicitly detaches it (`start …` on Windows, trailing `&` on POSIX). */
function interactiveReason(command: string): string | null {
  const c = command.trim();
  if (/(^|[\s&|;])start\s/i.test(c) || /&\s*$/.test(c)) return null; // intentional detach
  for (const { re, why } of INTERACTIVE_PATTERNS) if (re.test(c)) return why;
  return null;
}

const shellDescription = isWin
  ? 'Execute a command through Windows cmd.exe and return its output. Use cmd syntax (dir, del, type, copy, move, mkdir, rmdir) — NOT Unix commands (ls, rm, cat, grep). May require user approval.'
  : 'Execute a shell command through /bin/sh and return its output. May require user approval.';

export const shellTool = tool({
  name: 'shell',
  description: shellDescription,
  inputSchema: z.object({
    command: z.string().describe('Shell command to execute'),
    timeout: z.number().optional().describe('Timeout in seconds (default: 120)'),
  }),
  execute: async ({ command, timeout }) => {
    // Bail out early on commands that would just hang in a non-interactive shell.
    const reason = interactiveReason(command);
    if (reason) {
      return {
        output: '',
        exitCode: null,
        interactive: true,
        note:
          `Not run: this command ${reason}, which can't work in the captured (non-interactive) shell — ` +
          `it would hang with no way to send input. Ask the user to run it themselves in a real terminal, ` +
          `or use a non-interactive form (e.g. a build/test instead of a dev server, ` +
          `\`git commit -m "..."\`, or append \`&\`/\`start\` to detach).`,
      };
    }

    if (!(await approve(command))) {
      return { output: '', exitCode: null, denied: true, note: 'Command denied by user.' };
    }

    const timeoutMs = (timeout ?? 120) * 1000;
    const shell = isWin ? process.env.COMSPEC || 'cmd.exe' : process.env.SHELL || '/bin/sh';

    try {
      const { stdout, stderr } = await execAsync(command, {
        shell,
        timeout: timeoutMs,
        maxBuffer: 256 * 1024,
        windowsHide: true,
      });
      const output = (stdout + stderr).trim();
      const lines = output.split('\n');
      const truncated = lines.length > 2000;
      return {
        output: truncated ? lines.slice(-2000).join('\n') : output,
        exitCode: 0,
        ...(truncated && { truncated: true }),
      };
    } catch (err: any) {
      if (err.killed) {
        return {
          output: err.stdout?.trim() ?? '',
          exitCode: null,
          timedOut: true,
          note:
            `Timed out after ${timeout ?? 120}s. If this is an interactive program (a game/TUI, REPL) or a ` +
            `long-running server, it can't run in the captured shell — ask the user to run it in a real ` +
            `terminal. For a genuinely long task, pass a larger \`timeout\`.`,
        };
      }
      return {
        output: ((err.stdout ?? '') + (err.stderr ?? '')).trim(),
        exitCode: err.code ?? 1,
      };
    }
  },
});
