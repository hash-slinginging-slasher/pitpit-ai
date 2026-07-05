import { tool } from '@openrouter/agent/tool';
import { z } from 'zod';
import { readFile } from 'fs/promises';
import { extname } from 'path';
import { PDFParse } from 'pdf-parse';
import * as XLSX from 'xlsx';

const MAX_CHARS = 20000;
const TEXT_EXT = new Set([
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.xml', '.yaml', '.yml',
  '.log', '.html', '.htm', '.ini', '.toml', '.rtf', '.tex',
]);

function cap(text: string) {
  return text.length > MAX_CHARS
    ? { content: text.slice(0, MAX_CHARS) + '\n…[truncated]', truncated: true, totalChars: text.length }
    : { content: text };
}

export const viewDocumentTool = tool({
  name: 'view_document',
  description:
    'Read the text content of a document: PDF, spreadsheet (xlsx/xls/xlsm), CSV/TSV, or plain-text formats (txt, md, json, xml, yaml, html). Spreadsheets are returned as CSV per sheet. Use this for documents; use view_image for images.',
  inputSchema: z.object({
    path: z.string().describe('Path to the document file'),
  }),
  execute: async ({ path }) => {
    const ext = extname(path).toLowerCase();
    try {
      if (ext === '.pdf') {
        const parser = new PDFParse({ data: await readFile(path) });
        try {
          const result: any = await parser.getText();
          return { format: 'pdf', pages: result.total ?? result.numpages, ...cap((result.text ?? '').trim()) };
        } finally {
          await parser.destroy?.();
        }
      }

      if (ext === '.xlsx' || ext === '.xls' || ext === '.xlsm') {
        const wb = XLSX.read(await readFile(path), { type: 'buffer' });
        const parts = wb.SheetNames.map((name) => {
          const csv = XLSX.utils.sheet_to_csv(wb.Sheets[name]);
          return `### Sheet: ${name}\n${csv}`;
        });
        return { format: 'spreadsheet', sheets: wb.SheetNames, ...cap(parts.join('\n\n').trim()) };
      }

      if (TEXT_EXT.has(ext) || ext === '') {
        const buf = await readFile(path);
        if (buf.includes(0)) return { error: `Not a text document: ${path}` };
        return { format: 'text', ...cap(buf.toString('utf-8')) };
      }

      return { error: `Unsupported document type "${ext}". Try pdf, xlsx, csv, or a text format.` };
    } catch (err: any) {
      if (err.code === 'ENOENT') return { error: `Not found: ${path}` };
      return { error: err.message };
    }
  },
});
