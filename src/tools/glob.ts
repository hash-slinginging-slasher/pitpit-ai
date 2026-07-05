import { tool } from '@openrouter/agent/tool';
import { z } from 'zod';
import { glob } from 'glob';

export const globTool = tool({
  name: 'glob',
  description: 'Find files matching a glob pattern, e.g. "src/**/*.ts". Returns up to 200 paths.',
  inputSchema: z.object({
    pattern: z.string().describe('Glob pattern to match, e.g. "**/*.json"'),
    cwd: z.string().optional().describe('Directory to search from (default: current working directory)'),
  }),
  execute: async ({ pattern, cwd }) => {
    try {
      const matches = await glob(pattern, {
        cwd: cwd ?? process.cwd(),
        nodir: true,
        ignore: ['**/node_modules/**', '**/.git/**'],
        posix: true,
      });
      return { matches: matches.slice(0, 200), total: matches.length };
    } catch (err: any) {
      return { error: err.message };
    }
  },
});
