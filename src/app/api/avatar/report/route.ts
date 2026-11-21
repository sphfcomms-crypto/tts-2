import { NextRequest } from "next/server";

// The page tells the server here how her video kept up on the visitor's
// device (see report() in src/lib/avatar/liveTalk.ts). One line goes to the
// server's log: nothing is stored, and nothing in it is personal beyond
// the browser's own description of itself.

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const text = (await req.text()).slice(0, 2000);
  let facts: unknown = null;
  try {
    facts = JSON.parse(text);
  } catch {}
  if (facts && typeof facts === "object") {
    const browser = (req.headers.get("user-agent") || "").slice(0, 160);
    console.log(`[avatar] ${JSON.stringify(facts)} browser="${browser}"`);
  }
  return new Response(null, { status: 204 });
}
