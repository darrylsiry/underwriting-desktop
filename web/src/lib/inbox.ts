import { customerDb } from "./db";
import { inboxDir, loadFolder, readInbox, type InboxFolder } from "./inbox-files";
import { INBOX_MIN_OUTSTANDING, INBOX_TOP_UP, generateInboxSubmissions } from "./inbox-generate";

export const INBOX_MAX_BYTES = 25 * 1024 * 1024; // same cap as an upload

/** Drop-folder submissions not yet picked up (a picked-up folder has a submission row). */
async function outstanding(): Promise<InboxFolder[]> {
  const folders = readInbox(inboxDir());
  if (!folders.length) return [];
  const { rows } = await customerDb.query<{ inbox_folder: string }>(
    "SELECT inbox_folder FROM submissions WHERE inbox_folder = ANY($1)", [folders.map((f) => f.folder)],
  );
  const taken = new Set(rows.map((r) => r.inbox_folder));
  return folders.filter((f) => !taken.has(f.folder));
}

let refill: Promise<void> | null = null;
let lastFailure = 0;

/** Write INBOX_TOP_UP generated submissions into the drop folder; one at a time, and not again for a while after a failure. */
function topUp(): Promise<void> {
  refill ??= (async () => {
    try {
      const made = await generateInboxSubmissions(inboxDir(), INBOX_TOP_UP);
      console.log(`[inbox] fewer than ${INBOX_MIN_OUTSTANDING} submissions were waiting: ${made.length} generated (${made.map((m) => m.name).join(", ")})`);
    } catch (err) {
      lastFailure = Date.now();
      console.error(`[inbox] couldn't top up the drop folder at ${inboxDir()}: ${(err as Error).message}`);
    } finally {
      refill = null;
    }
  })();
  return refill;
}

/**
 * Drop-folder submissions waiting to be picked up. When fewer than INBOX_MIN_OUTSTANDING are left,
 * INBOX_TOP_UP new ones are generated first (INBOX_AUTO_TOP_UP=0 turns that off), so the inbox never
 * runs dry during a demo.
 */
export async function listInbox(): Promise<InboxFolder[]> {
  let open = await outstanding();
  if (open.length < INBOX_MIN_OUTSTANDING && process.env.INBOX_AUTO_TOP_UP !== "0" && Date.now() - lastFailure > 10 * 60_000) {
    await topUp();
    open = await outstanding();
  }
  return open;
}

export function inboxFiles(folder: string): File[] {
  return loadFolder(inboxDir(), folder, INBOX_MAX_BYTES);
}
