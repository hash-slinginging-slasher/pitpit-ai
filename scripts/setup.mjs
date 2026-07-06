#!/usr/bin/env node
// Installs the `coder` CLI globally by linking this package into the user's PATH.
// After this runs, `coder` can be invoked from any project directory; the agent
// operates on that directory while the model + API key come from the web UI config.
//
// Run via:  npm run setup
// Idempotent — safe to run repeatedly.
import { spawnSync } from 'child_process';

// npm link re-runs this package's install lifecycle in the global context, which
// would call this script again. This guard breaks that recursion.
if (process.env.CODER_LINKING === '1') {
  process.exit(0);
}

const isWin = process.platform === 'win32';

console.log('Linking the `coder` CLI globally...');
// Pass the full command as a single string (no args array) so shell:true does
// not trigger the DEP0190 arg-escaping warning. Args here are static, not user input.
const res = spawnSync(isWin ? 'npm.cmd link' : 'npm link', {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, CODER_LINKING: '1' },
});

if (res.status !== 0) {
  console.error('\n✗ Failed to link `coder`. Retry manually with:  npm link');
  process.exit(res.status ?? 1);
}

console.log('\n✓ `coder` is installed. Run it from any project directory.');
