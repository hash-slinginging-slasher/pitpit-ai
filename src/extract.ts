import { extname } from 'path';
import { PDFParse } from 'pdf-parse';
import * as XLSX from 'xlsx';

/**
 * Extract plain text from a document buffer for the brain (dropped attachments). Supports
 * pdf, spreadsheets, docx, and text formats; returns null when unsupported or on failure.
 */

const TEXT_EXT = new Set([
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.xml', '.yaml', '.yml',
  '.log', '.html', '.htm', '.ini', '.toml', '.tex',
]);

export async function extractText(buf: Buffer, filename: string): Promise<string | null> {
  const ext = extname(filename).toLowerCase();
  try {
    if (ext === '.pdf') {
      const parser = new PDFParse({ data: buf });
      try {
        const r: any = await parser.getText();
        return (r.text ?? '').trim() || null;
      } finally {
        await parser.destroy?.();
      }
    }
    if (ext === '.xlsx' || ext === '.xls' || ext === '.xlsm') {
      const wb = XLSX.read(buf, { type: 'buffer' });
      const out = wb.SheetNames.map((n) => `### Sheet: ${n}\n${XLSX.utils.sheet_to_csv(wb.Sheets[n])}`).join('\n\n').trim();
      return out || null;
    }
    if (ext === '.docx') {
      const mammoth = await import('mammoth');
      const r = await mammoth.extractRawText({ buffer: buf });
      return (r.value ?? '').trim() || null;
    }
    if (TEXT_EXT.has(ext) || ext === '') {
      if (buf.includes(0)) return null; // looks binary
      return buf.toString('utf-8');
    }
  } catch {
    return null;
  }
  return null;
}
