"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import ListingCard from "./ListingCard";
import {
  DEFAULT_PARAMS,
  SOURCE_LABELS,
  type Listing,
  type RunStats,
  type SearchParams,
  type SourceId,
} from "@/lib/types";

interface ProgressResponse {
  status: "idle" | "running" | "done" | "error";
  error?: string | null;
  stage?: { stage: string; done: number; total: number } | null;
  logCount?: number;
  logs: Array<{ level: LogLine["level"]; message: string; at: string }>;
  stats?: RunStats | null;
  listings?: Listing[];
}

interface Props {
  initialListings: Listing[];
  initialStats: RunStats | null;
  initialParams: SearchParams;
  finishedAt: string | null;
  aiConfigured: boolean;
}

type LogLine = { level: "info" | "warn" | "error" | "ok"; message: string; at: string };
type SortKey = "score" | "distance" | "price";

const LOG_COLOR: Record<LogLine["level"], string> = {
  info: "text-mute",
  ok: "text-good",
  warn: "text-warn",
  error: "text-bad",
};

const ALL_SOURCES = Object.keys(SOURCE_LABELS) as SourceId[];

export default function Dashboard({
  initialListings,
  initialStats,
  initialParams,
  finishedAt,
  aiConfigured,
}: Props) {
  const [params, setParams] = useState<SearchParams>({ ...DEFAULT_PARAMS, ...initialParams });
  const [listings, setListings] = useState<Listing[]>(initialListings);
  const [stats, setStats] = useState<RunStats | null>(initialStats);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [stage, setStage] = useState<{ stage: string; done: number; total: number } | null>(null);
  const [running, setRunning] = useState(false);
  const [lastRun, setLastRun] = useState<string | null>(finishedAt);

  const [sort, setSort] = useState<SortKey>("score");
  const [onlyOwners, setOnlyOwners] = useState(false);
  const [onlyExactGeo, setOnlyExactGeo] = useState(false);
  const [onlyWithPhone, setOnlyWithPhone] = useState(false);
  const [minScore, setMinScore] = useState(0);

  /** Сколько строк лога прогона уже показано — чтобы не тянуть их заново. */
  const shownLogsRef = useRef(0);
  const stoppedRef = useRef(false);
  const logBoxRef = useRef<HTMLDivElement | null>(null);

  const patch = <K extends keyof SearchParams>(key: K, value: SearchParams[K]) =>
    setParams((p) => ({ ...p, [key]: value }));

  const pushLog = (level: LogLine["level"], message: string) =>
    setLogs((prev) => {
      const next = [...prev, { level, message, at: new Date().toLocaleTimeString("ru-RU") }];
      queueMicrotask(() => logBoxRef.current?.scrollTo({ top: 1e6 }));
      return next.slice(-400);
    });

  /**
   * Прогон идёт на сервере как фоновая задача, здесь мы только спрашиваем прогресс.
   * Поэтому его переживают и перезагрузка страницы, и обрыв связи.
   */
  async function poll(): Promise<boolean> {
    const res = await fetch(`/api/progress?sinceLog=${shownLogsRef.current}`, {
      cache: "no-store",
    });
    const data = (await res.json()) as ProgressResponse;

    if (data.status === "idle") {
      // Сервер перезапустился и потерял задачу — показываем последний сохранённый прогон.
      pushLog("warn", "Прогон на сервере пропал (перезапуск), показываю последний сохранённый результат");
      try {
        const saved = (await (await fetch("/api/state", { cache: "no-store" })).json()) as {
          status: string;
          stats: RunStats;
          listings: Listing[];
        };
        if (saved.status === "done") {
          setStats(saved.stats);
          setListings(saved.listings);
        }
      } catch {
        /* показывать нечего */
      }
      return true;
    }

    if (data.logs?.length) {
      shownLogsRef.current = data.logCount ?? shownLogsRef.current + data.logs.length;
      setLogs((prev) =>
        [
          ...prev,
          ...data.logs.map((l) => ({
            level: l.level,
            message: l.message,
            at: new Date(l.at).toLocaleTimeString("ru-RU"),
          })),
        ].slice(-400),
      );
      queueMicrotask(() => logBoxRef.current?.scrollTo({ top: 1e6 }));
    }
    setStage(data.stage ?? null);

    if (data.status === "running") return false;

    if (data.stats) setStats(data.stats);
    setListings(data.listings ?? []);
    setLastRun(new Date().toISOString());
    if (data.status === "error" && data.error) pushLog("error", data.error);
    return true;
  }

  async function watchJob() {
    stoppedRef.current = false;
    setRunning(true);
    try {
      while (!stoppedRef.current) {
        await new Promise((r) => setTimeout(r, 1000));
        if (await poll()) break;
      }
    } catch (e) {
      pushLog("error", (e as Error).message);
    } finally {
      setRunning(false);
      setStage(null);
    }
  }

  async function startParsing() {
    if (running) return;
    setLogs([]);
    setStage(null);
    setListings([]);
    setStats(null);
    shownLogsRef.current = 0;

    await fetch("/api/parse", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    }).catch((e) => pushLog("error", (e as Error).message));

    await watchJob();
  }

  // Страницу могли перезагрузить посреди прогона — подхватываем его обратно.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = (await (await fetch("/api/progress", { cache: "no-store" })).json()) as ProgressResponse;
        if (!cancelled && data.status === "running") {
          shownLogsRef.current = 0;
          pushLog("info", "Подключился к прогону, который уже идёт на сервере");
          void watchJob();
        }
      } catch {
        /* сервер ещё поднимается — просто ждём действия пользователя */
      }
    })();
    return () => {
      cancelled = true;
      stoppedRef.current = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Останавливаем только слежение: сам прогон на сервере доработает и сохранит результат. */
  function stopParsing() {
    stoppedRef.current = true;
    pushLog("warn", "Перестал следить за прогоном. Он доработает на сервере — обновите страницу позже");
  }

  const visible = useMemo(() => {
    const out = listings.filter((l) => {
      if (onlyOwners && l.sellerType !== "owner") return false;
      if (onlyExactGeo && l.distanceKm === null) return false;
      if (onlyWithPhone && !l.phones?.length) return false;
      if (minScore > 0 && (l.ai?.score ?? 0) < minScore) return false;
      return true;
    });
    out.sort((a, b) => {
      if (sort === "price") return (a.price ?? 1e9) - (b.price ?? 1e9);
      if (sort === "distance") return (a.distanceKm ?? 99) - (b.distanceKm ?? 99);
      const diff = (b.ai?.score ?? -1) - (a.ai?.score ?? -1);
      return diff !== 0 ? diff : (a.distanceKm ?? 99) - (b.distanceKm ?? 99);
    });
    return out;
  }, [listings, onlyOwners, onlyExactGeo, onlyWithPhone, minScore, sort]);

  const top = visible.filter((l) => (l.ai?.score ?? 0) >= 80);

  return (
    <main className="mx-auto max-w-[1400px] px-5 py-8">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold">Жильё рядом с TAU · Астана</h1>
        <p className="mt-1 text-sm text-mute">
          Парсит krisha.kz и olx.kz, считает расстояние до университета, отсеивает подселение и
          ранжирует остальное через Gemini.
          {!aiConfigured && (
            <span className="ml-2 text-warn">Gemini не настроен — оценки не будет.</span>
          )}
        </p>
      </header>

      <div className="grid gap-6 lg:grid-cols-[360px_1fr]">
        {/* ── Панель настроек ──────────────────────────────────────────── */}
        <aside className="flex h-fit flex-col gap-5 rounded-2xl border border-line bg-ink-2 p-5 lg:sticky lg:top-6">
          <div>
            <div className="mb-2 text-sm font-medium">Цена, ₸ в месяц</div>
            <div className="flex items-center gap-2">
              <input
                type="number"
                step={5000}
                value={params.priceMin}
                onChange={(e) => patch("priceMin", Number(e.target.value))}
                className="w-full rounded-lg border border-line bg-ink px-3 py-2 text-sm"
              />
              <span className="text-mute">—</span>
              <input
                type="number"
                step={5000}
                value={params.priceMax}
                onChange={(e) => patch("priceMax", Number(e.target.value))}
                className="w-full rounded-lg border border-line bg-ink px-3 py-2 text-sm"
              />
            </div>
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between text-sm font-medium">
              <span>Радиус от университета</span>
              <span className="text-accent">{params.radiusKm} км</span>
            </div>
            <input
              type="range"
              min={0.5}
              max={10}
              step={0.5}
              value={params.radiusKm}
              onChange={(e) => patch("radiusKm", Number(e.target.value))}
              className="w-full accent-[#4f8cff]"
            />
            <div className="mt-1 text-xs text-mute">{params.anchorLabel}</div>
          </div>

          <div>
            <div className="mb-2 text-sm font-medium">Максимум комнат</div>
            <div className="flex gap-2">
              {[1, 2, 3].map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => patch("maxRooms", n)}
                  className={`flex-1 rounded-lg border px-3 py-2 text-sm transition ${
                    params.maxRooms === n
                      ? "border-accent bg-accent/15 text-accent"
                      : "border-line bg-ink text-mute hover:text-[#e8eeff]"
                  }`}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="mb-2 text-sm font-medium">Источники</div>
            <div className="flex flex-col gap-2">
              {ALL_SOURCES.map((s) => (
                <label key={s} className="flex cursor-pointer items-center gap-2 text-sm text-[#c6d2f0]">
                  <input
                    type="checkbox"
                    checked={params.sources.includes(s)}
                    onChange={(e) =>
                      patch(
                        "sources",
                        e.target.checked
                          ? [...params.sources, s]
                          : params.sources.filter((x) => x !== s),
                      )
                    }
                    className="size-4 accent-[#4f8cff]"
                  />
                  {SOURCE_LABELS[s]}
                </label>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-2 text-sm text-[#c6d2f0]">
            <label className="flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                checked={params.excludeShared}
                onChange={(e) => patch("excludeShared", e.target.checked)}
                className="size-4 accent-[#4f8cff]"
              />
              Убирать подселение и койко-места
            </label>
            <label className="flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                checked={params.geocodeMissing}
                onChange={(e) => patch("geocodeMissing", e.target.checked)}
                className="size-4 accent-[#4f8cff]"
              />
              Искать адрес по тексту (OSM, медленнее)
            </label>
            <label className="flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                checked={params.useAi}
                onChange={(e) => patch("useAi", e.target.checked)}
                className="size-4 accent-[#4f8cff]"
              />
              Оценивать через Gemini
            </label>
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between text-sm font-medium">
              <span>Страниц на источник</span>
              <span className="text-accent">{params.maxPages}</span>
            </div>
            <input
              type="range"
              min={1}
              max={15}
              value={params.maxPages}
              onChange={(e) => patch("maxPages", Number(e.target.value))}
              className="w-full accent-[#4f8cff]"
            />
          </div>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={startParsing}
              disabled={running}
              className="flex-1 rounded-xl bg-accent px-4 py-3 font-medium text-white transition hover:bg-[#3d7bf0] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {running ? "Идёт парсинг…" : "Начать парсинг"}
            </button>
            {running && (
              <button
                type="button"
                onClick={stopParsing}
                title="Прогон продолжится на сервере"
                className="rounded-xl border border-line px-4 py-3 text-sm text-mute hover:text-bad"
              >
                Отвязаться
              </button>
            )}
          </div>

          {stage && (
            <div>
              <div className="mb-1 flex justify-between text-xs text-mute">
                <span>{stage.stage}</span>
                <span>
                  {stage.done}/{stage.total}
                </span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-ink-3">
                <div
                  className="h-full rounded-full bg-accent transition-all"
                  style={{ width: `${stage.total ? (stage.done / stage.total) * 100 : 0}%` }}
                />
              </div>
            </div>
          )}

          {logs.length > 0 && (
            <div
              ref={logBoxRef}
              className="max-h-64 overflow-y-auto rounded-xl border border-line bg-ink p-3 font-mono text-[11px] leading-relaxed"
            >
              {logs.map((l, i) => (
                <div key={i} className={LOG_COLOR[l.level]}>
                  <span className="opacity-40">{l.at}</span> {l.message}
                </div>
              ))}
            </div>
          )}
        </aside>

        {/* ── Результаты ──────────────────────────────────────────────── */}
        <section className="flex flex-col gap-4">
          {stats && (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Собрано объявлений" value={stats.fetched} />
              <Stat label="Прошло фильтры" value={stats.kept} accent />
              <Stat label="Оценено ИИ" value={stats.aiScored} />
              <Stat
                label="Отсеяно"
                value={Object.values(stats.rejected).reduce((a, b) => a + b, 0)}
              />
            </div>
          )}

          {stats && (
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-mute">
              <span>дорого/дёшево: {stats.rejected.price}</span>
              <span>много комнат: {stats.rejected.rooms}</span>
              <span>далеко: {stats.rejected.distance}</span>
              <span>подселение: {stats.rejected.shared}</span>
              <span>посуточно: {stats.rejected.daily}</span>
              <span>адрес не найден: {stats.rejected["no-geo"]}</span>
              <span>дубли: {stats.rejected.duplicate}</span>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-ink-2 px-4 py-3 text-sm">
            <span className="text-mute">Сортировка:</span>
            {(
              [
                ["score", "по оценке ИИ"],
                ["distance", "по расстоянию"],
                ["price", "по цене"],
              ] as Array<[SortKey, string]>
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setSort(key)}
                className={`rounded-lg px-2.5 py-1 transition ${
                  sort === key ? "bg-accent/15 text-accent" : "text-mute hover:text-[#e8eeff]"
                }`}
              >
                {label}
              </button>
            ))}

            <span className="ml-auto flex items-center gap-3">
              <label className="flex cursor-pointer items-center gap-1.5 text-mute">
                <input
                  type="checkbox"
                  checked={onlyOwners}
                  onChange={(e) => setOnlyOwners(e.target.checked)}
                  className="size-4 accent-[#4f8cff]"
                />
                только хозяева
              </label>
              <label className="flex cursor-pointer items-center gap-1.5 text-mute">
                <input
                  type="checkbox"
                  checked={onlyExactGeo}
                  onChange={(e) => setOnlyExactGeo(e.target.checked)}
                  className="size-4 accent-[#4f8cff]"
                />
                точный адрес
              </label>
              <label className="flex cursor-pointer items-center gap-1.5 text-mute">
                <input
                  type="checkbox"
                  checked={onlyWithPhone}
                  onChange={(e) => setOnlyWithPhone(e.target.checked)}
                  className="size-4 accent-[#4f8cff]"
                />
                с номером
              </label>
              <label className="flex items-center gap-1.5 text-mute">
                оценка ≥
                <input
                  type="number"
                  min={0}
                  max={100}
                  step={10}
                  value={minScore}
                  onChange={(e) => setMinScore(Number(e.target.value))}
                  className="w-16 rounded-lg border border-line bg-ink px-2 py-1"
                />
              </label>
            </span>
          </div>

          {top.length > 0 && (
            <div className="rounded-xl border border-good/30 bg-good/5 px-4 py-3 text-sm text-[#bff2d6]">
              <b>{top.length}</b> вариант(ов) с оценкой 80+ — на них стоит написать в первую очередь.
            </div>
          )}

          {visible.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-line p-10 text-center text-mute">
              {running
                ? "Собираю объявления…"
                : lastRun
                  ? "По этим фильтрам ничего не нашлось. Попробуйте расширить радиус или бюджет."
                  : "Нажмите «Начать парсинг» слева."}
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {visible.map((l) => (
                <ListingCard key={l.id} listing={l} />
              ))}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

function Stat({ label, value, accent }: { label: string; value: number; accent?: boolean }) {
  return (
    <div className="rounded-xl border border-line bg-ink-2 px-4 py-3">
      <div className={`text-2xl font-semibold ${accent ? "text-good" : ""}`}>{value}</div>
      <div className="text-xs text-mute">{label}</div>
    </div>
  );
}
