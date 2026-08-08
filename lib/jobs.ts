import "server-only";
import { runSearch } from "./pipeline";
import { emptyStats, type Listing, type ProgressEvent, type RunStats, type SearchParams } from "./types";

/**
 * Прогон занимает минуты, поэтому он не привязан к HTTP-запросу: задача живёт
 * на сервере, а фронт спрашивает прогресс отдельными короткими запросами.
 * Это переживает и перезагрузку страницы, и обрыв соединения.
 */

export interface JobLogLine {
  level: "info" | "warn" | "error" | "ok";
  message: string;
  at: string;
}

export interface JobSnapshot {
  id: number;
  status: "running" | "done" | "error";
  startedAt: string;
  finishedAt: string | null;
  logs: JobLogLine[];
  stage: { stage: string; done: number; total: number } | null;
  stats: RunStats;
  listings: Listing[];
  error: string | null;
}

interface Job extends JobSnapshot {
  params: SearchParams;
}

let current: Job | null = null;
let nextId = 1;

export function getJob(): JobSnapshot | null {
  return current;
}

export function isRunning(): boolean {
  return current?.status === "running";
}

/** Запускает прогон. Если предыдущий ещё идёт, возвращает его. */
export function startJob(params: SearchParams): JobSnapshot {
  if (current?.status === "running") return current;

  const job: Job = {
    id: nextId++,
    params,
    status: "running",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    logs: [],
    stage: null,
    stats: emptyStats(),
    listings: [],
    error: null,
  };
  current = job;

  void (async () => {
    try {
      for await (const event of runSearch(params)) apply(job, event);
      if (job.status === "running") {
        job.status = "done";
        job.finishedAt = new Date().toISOString();
      }
    } catch (e) {
      job.status = "error";
      job.error = (e as Error).message;
      job.finishedAt = new Date().toISOString();
    }
  })();

  return job;
}

function apply(job: Job, event: ProgressEvent): void {
  switch (event.type) {
    case "log":
      job.logs.push({
        level: event.level,
        message: event.message,
        at: new Date().toISOString(),
      });
      // Лог показывается целиком, но расти бесконечно ему незачем.
      if (job.logs.length > 500) job.logs.splice(0, job.logs.length - 500);
      break;
    case "stage":
      job.stage = { stage: event.stage, done: event.done, total: event.total };
      break;
    case "listing":
      job.listings.push(event.listing);
      break;
    case "done":
      job.stats = event.stats;
      job.stage = null;
      job.status = "done";
      job.finishedAt = new Date().toISOString();
      break;
    case "error":
      job.error = event.message;
      job.status = "error";
      job.finishedAt = new Date().toISOString();
      break;
  }
}
