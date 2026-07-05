import { tool } from '@openrouter/agent/tool';
import { z } from 'zod';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

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
    const shellArgs = isWin ? ['/d', '/s', '/c', command] : ['-c', command];

    try {
      const { stdout, stderr } = await execFileAsync(shell, shellArgs, {
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
