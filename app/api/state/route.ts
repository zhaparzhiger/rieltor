import { readState } from "@/lib/store";
import { hasGemini } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const state = await readState();
  return Response.json({ ...state, aiConfigured: hasGemini() });
}
