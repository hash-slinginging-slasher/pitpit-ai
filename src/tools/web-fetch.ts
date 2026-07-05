import { tool } from '@openrouter/agent/tool';
import { z } from 'zod';

const MAX_CHARS = 12000;

/** Crude HTML → text: drop script/style, strip tags, decode a few entities, collapse whitespace. */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|br)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

export const webFetchTool = tool({
  name: 'web_fetch',
  description:
    'Fetch a URL and return its readable text content (HTML is stripped to text). Use to read documentation, API references, or a specific page. For discovery use web_search instead.',
  inputSchema: z.object({
    url: z.string().describe('The URL to fetch (http/https)'),
  }),
  execute: async ({ url }) => {
    if (!/^https?:\/\//i.test(url)) return { error: 'url must start with http:// or https://' };
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20000);
      const r = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'openrouter-coding-agent/0.1 (+web_fetch)' },
      });
      clearTimeout(timer);
      if (!r.ok) return { error: `HTTP ${r.status} ${r.statusText}`, url };
      const type = r.headers.get('content-type') ?? '';
      const raw = await r.text();
      const text = /html/i.test(type) ? htmlToText(raw) : raw;
      const truncated = text.length > MAX_CHARS;
      return {
        url,
        contentType: type,
        content: truncated ? text.slice(0, MAX_CHARS) + '\n…[truncated]' : text,
        ...(truncated && { truncated: true, totalChars: text.length }),
      };
    } catch (err: any) {
      if (err.name === 'AbortError') return { error: `Timed out fetching ${url}` };
      return { error: err.message };
    }
  },
});
