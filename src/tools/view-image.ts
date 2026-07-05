import { tool } from '@openrouter/agent/tool';
import { z } from 'zod';
import { readFile } from 'fs/promises';
import { extname } from 'path';

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};

export const viewImageTool = tool({
  name: 'view_image',
  description:
    'Look at an image file (screenshot, mockup, diagram, photo). Use this whenever the user refers to an image or screenshot. The image is shown to you directly. Requires a vision-capable model.',
  inputSchema: z.object({
    path: z.string().describe('Path to the image file (png, jpg, gif, webp, bmp)'),
  }),
  execute: async ({ path }) => {
    const ext = extname(path).toLowerCase();
    const mime = MIME[ext];
    if (!mime) return { error: `Unsupported image type "${ext}". Supported: ${Object.keys(MIME).join(', ')}` };
    try {
      const buf = await readFile(path);
      return { imageUrl: `data:${mime};base64,${buf.toString('base64')}`, path, bytes: buf.length };
    } catch (err: any) {
      if (err.code === 'ENOENT') return { error: `Image not found: ${path}` };
      return { error: err.message };
    }
  },
  // Hand the actual pixels to the (vision) model instead of the raw base64 blob.
  toModelOutput: ({ output }) => {
    if ('error' in output) {
      return { type: 'content', value: [{ type: 'input_text', text: output.error as string }] };
    }
    return {
      type: 'content',
      value: [
        { type: 'input_text', text: `Image: ${output.path} (${output.bytes} bytes)` },
        { type: 'input_image', detail: 'auto', imageUrl: output.imageUrl as string },
      ],
    };
  },
});
