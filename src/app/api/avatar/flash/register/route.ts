import { NextRequest } from "next/server";
import { keyMatches } from "@/lib/avatarGpu";
import { setFlashAddress } from "@/lib/avatarFlash";

// The whole-face server calls this when it starts, to say where it can be
// reached.
//
//   POST /api/avatar/flash/register   { "url": "https://….trycloudflare.com" }
//   header x-avatar-key: the shared secret

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (!keyMatches(req.headers.get("x-avatar-key"))) {
    return new Response("Not allowed", { status: 401 });
  }
  let url = "";
  try {
    url = String((await req.json()).url ?? "");
  } catch {}
  if (!setFlashAddress(url)) {
    return new Response("That address is not accepted", { status: 400 });
  }
  return Response.json({ ok: true });
}
