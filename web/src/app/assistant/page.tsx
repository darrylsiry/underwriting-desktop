import type { Metadata } from "next";
import { ASSISTANT_MODEL, assistantEnabled } from "@/lib/assistant";
import { currentUser } from "@/lib/user";
import { AssistantChat } from "./chat";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "AI Assistant" };   // UX-010

const SUGGESTIONS = [
  "What's waiting in the inbox?",
  "How much premium did we write this month, and which policies make it up?",
  "Which renewals are due in the next 30 days?",
  "Why is Q-2026-0004 priced the way it is?",
  "Which submissions have open referrals, and what are they?",
  "What has been pushed to the GL and what hasn't?",
  "Who bound the most premium this year?",
];

/** The AI assistant: ask anything about the app; Claude answers from the app's data with links. `?q=` (the desk's ask box) asks it on arrival. */
export default async function AssistantPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const [user, { q }] = await Promise.all([currentUser(), searchParams]);
  return (
    <main className="mx-auto max-w-4xl p-6 lg:p-8">
      <h1 className="text-2xl font-semibold">AI Assistant</h1>
      <p className="mt-1 text-sm text-slate-500">Ask a question about anything in the Underwriting Desktop. Every answer is looked up in the app and links to the records it rests on.</p>
      <div className="mt-6">
        <AssistantChat user={user} model={ASSISTANT_MODEL} enabled={assistantEnabled()} suggestions={SUGGESTIONS} initialQuestion={q?.trim() || undefined} />
      </div>
    </main>
  );
}
