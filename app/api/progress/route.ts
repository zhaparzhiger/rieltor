import { NextRequest } from "next/server";
import { getJob } from "@/lib/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Короткий опрос вместо длинного соединения: `sinceLog` — сколько строк лога
 * фронт уже показал, объявления отдаём только когда прогон закончился.
 */
export async function GET(req: NextRequest) {
  const job = getJob();
  if (!job) return Response.json({ status: "idle" });

  const sinceLog = Number(req.nextUrl.searchParams.get("sinceLog") ?? 0);
  const finished = job.status !== "running";

  return Response.json({
    jobId: job.id,
    status: job.status,
    error: job.error,
    stage: job.stage,
    logCount: job.logs.length,
    logs: job.logs.slice(Math.max(0, sinceLog)),
    stats: finished ? job.stats : null,
    listings: finished ? job.listings : [],
  });
}
