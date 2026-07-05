import { tool } from '@openrouter/agent/tool';
import { z } from 'zod';
import { writeFile, mkdir } from 'fs/promises';
import { dirname, resolve } from 'path';
import { readApiKey, readAgents } from '../config.js';

let counter = 0;

/** Pull a base64 image data URL out of an OpenRouter chat-completion response. */
function extractImageDataUrl(msg: any): string | undefined {
  const imgs = msg?.images;
  if (Array.isArray(imgs)) {
    for (const im of imgs) {
      const url = im?.image_url?.url ?? im?.url ?? (typeof im === 'string' ? im : undefined);
      if (typeof url === 'string' && url.startsWith('data:image')) return url;
    }
  }
  if (Array.isArray(msg?.content)) {
    for (const c of msg.content) {
      const url = c?.image_url?.url ?? c?.url;
      if (typeof url === 'string' && url.startsWith('data:image')) return url;
    }
  }
  return undefined;
}

export const generateImageTool = tool({
  name: 'generate_image',
  description:
    "Create an image from a text prompt using the Image agent's configured model (set in the web UI's Image tab). Saves a PNG/JPG file and returns its path.",
  inputSchema: z.object({
    prompt: z.string().describe('Description of the image to generate'),
    path: z.string().optional().describe('Where to save the image (default: generated-image-N.png in cwd)'),
  }),
  execute: async ({ prompt, path }) => {
    const apiKey = readApiKey();
    if (!apiKey) return { error: 'No API key set. Add it in the web UI Settings.' };
    const chain = readAgents().image;
    if (!chain.length) return { error: 'No Image agent model configured. Add one in the web UI (Image tab).' };

    // Try each model in the Image failover chain until one returns an image.
    const attempts: string[] = [];
    for (let i = 0; i < chain.length; i++) {
      const model = chain[i];
      try {
        const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], modalities: ['image', 'text'] }),
        });
        if (!r.ok) {
          attempts.push(`${model}: HTTP ${r.status}`);
          continue;
        }
        const body: any = await r.json();
        const dataUrl = extractImageDataUrl(body?.choices?.[0]?.message);
        if (!dataUrl) {
          attempts.push(`${model}: no image returned`);
          continue;
        }
        const m = dataUrl.match(/^data:(image\/(\w+));base64,(.*)$/);
        if (!m) {
          attempts.push(`${model}: bad image format`);
          continue;
        }
        const buf = Buffer.from(m[3], 'base64');
        const out = resolve(path ?? `generated-image-${++counter}.${m[2] === 'jpeg' ? 'jpg' : m[2]}`);
        await mkdir(dirname(out), { recursive: true });
        await writeFile(out, buf);
        return { ok: true, path: out, bytes: buf.length, model, failedOver: i > 0 };
      } catch (err: any) {
        attempts.push(`${model}: ${err.message}`);
      }
    }
    return { error: `All Image models failed. ${attempts.join('; ')}` };
  },
});
