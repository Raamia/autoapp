import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { resolve, extname, basename, sep } from 'node:path';

const ATTACH_DIR = resolve(process.cwd(), 'attachments');

/** Gmail's own ceiling is 25 MB; a resume has no business being near it. */
export const MAX_BYTES = 10 * 1024 * 1024;

const MIME_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.txt': 'text/plain',
};

export class AttachmentError extends Error {}

/**
 * Reduce an uploaded name to a safe ASCII basename inside attachments/.
 * The browser supplies this string, so "../../token.json" has to die here.
 */
function safePath(filename: string): string {
  const name = basename(filename).replace(/[^A-Za-z0-9._-]/g, '_');
  if (!name || name.startsWith('.')) throw new AttachmentError('Invalid file name.');
  if (!(extname(name).toLowerCase() in MIME_TYPES)) {
    throw new AttachmentError('Resume must be a .pdf, .doc, .docx or .txt file.');
  }
  const full = resolve(ATTACH_DIR, name);
  if (!full.startsWith(ATTACH_DIR + sep)) throw new AttachmentError('Invalid file name.');
  return full;
}

export interface ResumeInfo {
  filename: string;
  size: number;
}

export function saveResume(filename: string, base64: string): ResumeInfo {
  const content = Buffer.from(base64, 'base64');
  if (content.length === 0) throw new AttachmentError('That file appears to be empty.');
  if (content.length > MAX_BYTES) {
    throw new AttachmentError(
      `Resume is ${(content.length / 1024 / 1024).toFixed(1)} MB — keep it under 10 MB.`,
    );
  }
  const full = safePath(filename);
  mkdirSync(ATTACH_DIR, { recursive: true });

  // One resume at a time: drop any previous file so attachments/ can't accumulate.
  clearAll();
  writeFileSync(full, content);
  return { filename: basename(full), size: content.length };
}

export function resumeInfo(filename: string | null): ResumeInfo | null {
  if (!filename) return null;
  try {
    const full = safePath(filename);
    if (!existsSync(full)) return null;
    return { filename: basename(full), size: statSync(full).size };
  } catch {
    return null;
  }
}

export interface LoadedAttachment {
  filename: string;
  content: Buffer;
  mimeType: string;
}

export function readResume(filename: string): LoadedAttachment {
  const full = safePath(filename);
  if (!existsSync(full)) throw new AttachmentError(`Resume file is missing: ${filename}`);
  return {
    filename: basename(full),
    content: readFileSync(full),
    mimeType: MIME_TYPES[extname(full).toLowerCase()],
  };
}

export function clearAll(): void {
  if (existsSync(ATTACH_DIR)) rmSync(ATTACH_DIR, { recursive: true, force: true });
  mkdirSync(ATTACH_DIR, { recursive: true });
}
