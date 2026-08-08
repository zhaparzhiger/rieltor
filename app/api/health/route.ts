import { hasGemini } from "@/lib/env";
import { getJob } from "@/lib/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Health-check для хостинга: отвечает всегда, даже когда Gemini не настроен. */
export async function GET() {
  return Response.json({
    ok: true,
    ai: hasGemini(),
    job: getJob()?.status ?? "idle",
    uptimeSec: Math.round(process.uptime()),
  });
}
