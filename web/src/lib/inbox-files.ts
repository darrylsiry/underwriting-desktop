import fs from "node:fs";
import path from "node:path";

/**
 * The broker drop folder: one sub-folder per submission, holding the files the broker sent.
 * Pure filesystem helpers (no DB, no path aliases) so node --test can import them directly.
 */

export type InboxFile = { name: string; size: number; contentType: string };
export type InboxFolder = { folder: string; title: string; files: InboxFile[]; receivedAt: Date };

const CONTENT_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".eml": "message/rfc822",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".txt": "text/plain",
};

/** Folder names are path segments chosen by whoever fills the drop folder; never allow traversal. */
export const isSafeName = (name: string) => /^[A-Za-z0-9][A-Za-z0-9._ -]{0,120}$/.test(name) && !name.includes("..");

export const contentTypeFor = (filename: string) =>
  CONTENT_TYPES[path.extname(filename).toLowerCase()] ?? "application/octet-stream";

const ACRONYMS = new Set(["gc", "hvac", "llc", "inc", "hoa", "mep", "usa"]);

/** "09-rio-bravo-concrete" -> "Rio Bravo Concrete" (a leading case number is dropped). */
export function folderTitle(folder: string): string {
  return folder
    .replace(/^\d+[-_ ]+/, "")
    .split(/[-_ ]+/)
    .filter(Boolean)
    .map((w) => (ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
    .join(" ");
}

/** The drop folder: SUBMISSION_INBOX_DIR, else the repo's samples (local dev), else ./inbox (Docker image). */
export function inboxDir(cwd = process.cwd(), env: Record<string, string | undefined> = process.env): string {
  if (env.SUBMISSION_INBOX_DIR) return path.resolve(cwd, env.SUBMISSION_INBOX_DIR);
  const samples = path.resolve(cwd, "..", "samples", "submissions");
  return fs.existsSync(samples) ? samples : path.resolve(cwd, "inbox");
}

/** Every submission folder with at least one readable document, newest first. */
export function readInbox(dir: string): InboxFolder[] {
  if (!fs.existsSync(dir)) return [];
  const folders: InboxFolder[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !isSafeName(entry.name)) continue;
    const files = readFolderFiles(dir, entry.name);
    if (!files.length) continue;
    const receivedAt = new Date(Math.max(...files.map((f) => fs.statSync(path.join(dir, entry.name, f.name)).mtimeMs)));
    folders.push({ folder: entry.name, title: folderTitle(entry.name), files, receivedAt });
  }
  return folders.sort((a, b) => b.folder.localeCompare(a.folder));
}

function readFolderFiles(dir: string, folder: string): InboxFile[] {
  return fs.readdirSync(path.join(dir, folder), { withFileTypes: true })
    .filter((f) => f.isFile() && isSafeName(f.name) && !f.name.startsWith("."))
    .map((f) => ({ name: f.name, size: fs.statSync(path.join(dir, folder, f.name)).size, contentType: contentTypeFor(f.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Load one folder's documents as File objects, ready for the same path an upload takes. */
export function loadFolder(dir: string, folder: string, maxBytes: number): File[] {
  if (!isSafeName(folder)) throw new Error("Not an inbox folder");
  const full = path.join(dir, folder);
  if (path.dirname(full) !== path.resolve(dir) || !fs.existsSync(full) || !fs.statSync(full).isDirectory()) {
    throw new Error(`${folder} is no longer in the inbox`);
  }
  const files = readFolderFiles(dir, folder);
  if (!files.length) throw new Error(`${folder} has no documents`);
  if (files.reduce((n, f) => n + f.size, 0) > maxBytes) throw new Error(`${folder} is larger than ${maxBytes / 1024 / 1024} MB`);
  return files.map((f) => new File([fs.readFileSync(path.join(full, f.name))], f.name, { type: f.contentType }));
}
