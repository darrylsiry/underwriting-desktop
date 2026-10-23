import { customerDb } from "./db";
import { inboxDir, loadFolder, readInbox, type InboxFolder } from "./inbox-files";

export const INBOX_MAX_BYTES = 25 * 1024 * 1024; // same cap as an upload

/** Drop-folder submissions not yet picked up (a picked-up folder has a submission row). */
export async function listInbox(): Promise<InboxFolder[]> {
  const folders = readInbox(inboxDir());
  if (!folders.length) return [];
  const { rows } = await customerDb.query<{ inbox_folder: string }>(
    "SELECT inbox_folder FROM submissions WHERE inbox_folder = ANY($1)", [folders.map((f) => f.folder)],
  );
  const taken = new Set(rows.map((r) => r.inbox_folder));
  return folders.filter((f) => !taken.has(f.folder));
}

export function inboxFiles(folder: string): File[] {
  return loadFolder(inboxDir(), folder, INBOX_MAX_BYTES);
}
