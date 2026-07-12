import { loadConfig } from './src/config.js';
import { runAgent } from './src/agent.js';
const config = loadConfig({}, {});
const m = 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free';
const t0 = Date.now(); let reasoning = 0, text = '';
console.log('testing', m, '(60s budget)...');
try {
  const r = await runAgent({...config, maxSteps: 2}, m, 'Reply with exactly: OK', {
    noTools: true,
    onEvent: (e) => { if (e.type==='reasoning') reasoning += e.delta.length; else if (e.type==='text') text += e.delta; },
  });
  console.log(`${((Date.now()-t0)/1000).toFixed(1)}s | reasoning chars streamed: ${reasoning} | final text: ${JSON.stringify(r.text.trim().slice(0,40))}`);
} catch (e:any) { console.log(`${((Date.now()-t0)/1000).toFixed(1)}s FAILED: ${e?.status??''} ${String(e.message).slice(0,70)}`); }
