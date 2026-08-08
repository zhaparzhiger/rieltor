import { NextRequest } from "next/server";
import { getJob, startJob } from "@/lib/jobs";
import { DEFAULT_PARAMS, type SearchParams, type SourceId } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 900;

const ALL_SOURCES: SourceId[] = [
  "krisha-kvartiry",
  "krisha-komnaty",
  "olx-kvartiry",
  "olx-komnaty",
];

function clamp(n: unknown, min: number, max: number, fallback: number): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, v));
}

function parseParams(body: unknown): SearchParams {
  const b = (body ?? {}) as Partial<SearchParams>;
  const sources = Array.isArray(b.sources)
    ? b.sources.filter((s): s is SourceId => ALL_SOURCES.includes(s as SourceId))
    : DEFAULT_PARAMS.sources;

  const priceMin = clamp(b.priceMin, 0, 5_000_000, DEFAULT_PARAMS.priceMin);
  const priceMax = clamp(b.priceMax, priceMin, 5_000_000, DEFAULT_PARAMS.priceMax);

  return {
    anchorLat: clamp(b.anchorLat, 50.9, 51.35, DEFAULT_PARAMS.anchorLat),
    anchorLon: clamp(b.anchorLon, 71.15, 71.8, DEFAULT_PARAMS.anchorLon),
    anchorLabel: String(b.anchorLabel ?? DEFAULT_PARAMS.anchorLabel).slice(0, 120),
    radiusKm: clamp(b.radiusKm, 0.3, 25, DEFAULT_PARAMS.radiusKm),
    priceMin,
    priceMax,
    maxRooms: clamp(b.maxRooms, 1, 5, DEFAULT_PARAMS.maxRooms),
    sources: sources.length ? sources : DEFAULT_PARAMS.sources,
    maxPages: clamp(b.maxPages, 1, 25, DEFAULT_PARAMS.maxPages),
    excludeShared: b.excludeShared ?? DEFAULT_PARAMS.excludeShared,
    geocodeMissing: b.geocodeMissing ?? DEFAULT_PARAMS.geocodeMissing,
    useAi: b.useAi ?? DEFAULT_PARAMS.useAi,
  };
}

/** Ставит прогон в работу и сразу отвечает: за прогрессом фронт ходит в /api/progress. */
export async function POST(req: NextRequest) {
  const params = parseParams(await req.json().catch(() => ({})));
  const job = startJob(params);
  return Response.json({ jobId: job.id, status: job.status });
}

export async function GET() {
  const job = getJob();
  return Response.json(job ? { jobId: job.id, status: job.status } : { status: "idle" });
}
