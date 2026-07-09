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
        return { output: err.stdout?.trim() ?? '', exitCode: null, timedOut: true };
      }
      return {
        output: ((err.stdout ?? '') + (err.stderr ?? '')).trim(),
        exitCode: err.code ?? 1,
      };
    }
  },
});
