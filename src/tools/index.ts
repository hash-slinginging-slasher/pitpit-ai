import { serverTool } from '@openrouter/agent';
import { fileReadTool } from './file-read.js';
import { fileWriteTool } from './file-write.js';
import { fileEditTool } from './file-edit.js';
import { multiEditTool } from './multi-edit.js';
import { deleteFileTool } from './delete-file.js';
import { moveFileTool } from './move-file.js';
import { copyFileTool } from './copy-file.js';
import { makeDirTool } from './make-dir.js';
import { globTool } from './glob.js';
import { grepTool } from './grep.js';
import { listDirTool } from './list-dir.js';
import { shellTool } from './shell.js';
import { viewImageTool } from './view-image.js';
import { viewDocumentTool } from './view-document.js';
import { webFetchTool } from './web-fetch.js';
import { docsLookupTool } from './docs-lookup.js';
import { generateImageTool } from './generate-image.js';
import { brainNoteTool } from './brain-note.js';
import { boardTaskTool } from './board-task.js';

export const tools = [
  // File operations
  fileReadTool,
  fileWriteTool,
  fileEditTool,
  multiEditTool,
  deleteFileTool,
  moveFileTool,
  copyFileTool,
  makeDirTool,

  // Search
  globTool,
  grepTool,
  listDirTool,

  // Shell
  shellTool,

  // Media & documents
  viewImageTool,
  viewDocumentTool,
  generateImageTool,

  // Web
  webFetchTool,
  serverTool({ type: 'openrouter:web_search' }),

  // Up-to-date library documentation (Context7)
  docsLookupTool,

  // Project brain (second brain)
  brainNoteTool,

  // Kanban board
  boardTaskTool,
];
