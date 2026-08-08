import "server-only";
import { classifyBank, extractAddressCandidates } from "./address";
import { fallbackMessage, GeminiQuotaError, scoreBatch } from "./ai";
import { Channel } from "./channel";
import { hasGemini } from "./env";
import { geocode, haversineKm, insideAstana, isUsefulGeoQuery, normalizeAddress } from "./geo";
import { sleep } from "./http";
import { crawlKrisha, enrichKrisha, type CrawlContext } from "./sources/krisha";
import { crawlOlx, enrichOlxPhones } from "./sources/olx";
import { writeState } from "./store";
import {
  emptyStats,
  SOURCE_LABELS,
  type Listing,
  type ProgressEvent,
  type RejectReason,
  type RunStats,
  type SearchParams,
} from "./types";

const AI_BATCH = 12;
/** Пауза между запросами к Gemini, чтобы не ловить 429 на бесплатной квоте. */
const AI_PAUSE_MS = 6000;
/** Допуск для адресов, найденных только по улице или кварталу. */
const APPROX_SLACK_KM = 1.5;
/** Запас на этапе предварительного отсева: точные координаты подтянутся позже. */
const RADIUS_SLACK_KM = 0.8;
/** Сколько номеров тянем сразу — по лучшим вариантам, остальные по кнопке. */
const PHONE_PREFETCH = 12;

function dedupeKey(l: Listing): string {
  const text = l.description.toLowerCase().replace(/[^a-zа-яё0-9]/gi, "").slice(0, 80);
  return `${l.price ?? "-"}|${l.area ?? "-"}|${text}`;
}

/** Ставит координаты объявлению: сначала адрес из карточки, потом улицы из текста. */
async function locate(l: Listing): Promise<void> {
  const queries: Array<{ query: string; precise: boolean }> = [];
  const fromAddress = normalizeAddress(l.address);
  if (fromAddress) queries.push({ query: fromAddress, precise: /\d/.test(fromAddress) });
  queries.push(...extractAddressCandidates(l.title, l.description));

  for (const { query } of queries.filter((q) => isUsefulGeoQuery(q.query)).slice(0, 4)) {
    const point = await geocode(query);
    if (!point) continue;
    l.lat = point.lat;
    l.lon = point.lon;
    l.geoSource = point.precision === "exact" ? "geocoded" : "approx";
    // Точный адрес прекращает поиск, приблизительный оставляем как запасной.
    if (point.precision === "exact") return;
  }
}

function distanceTo(l: Listing, params: SearchParams): number | null {
  if (l.lat === null || l.lon === null || !insideAstana(l.lat, l.lon)) return null;
  return haversineKm(params.anchorLat, params.anchorLon, l.lat, l.lon);
}

/** Для приблизительных адресов радиус растягиваем — точка стоит на середине улицы. */
function radiusFor(l: Listing, params: SearchParams): number {
  return l.geoSource === "approx" ? params.radiusKm + APPROX_SLACK_KM : params.radiusKm;
}

/**
 * Один прогон: выдача источников → координаты → радиус → подробности → ИИ.
 * События отдаются потоком, чтобы фронт показывал живой лог.
 */
export function runSearch(params: SearchParams): AsyncIterable<ProgressEvent> {
  const channel = new Channel<ProgressEvent>();

  const ctx: CrawlContext = {
    log: (level, message) => channel.push({ type: "log", level, message }),
    stage: (stage, done, total) => channel.push({ type: "stage", stage, done, total }),
  };

  void (async () => {
    const stats: RunStats = emptyStats();
    const reject = (reason: RejectReason) => {
      stats.rejected[reason]++;
    };

    try {
      // ── 1. Выдача источников ───────────────────────────────────────────────
      const raw: Listing[] = [];
      for (const source of params.sources) {
        ctx.log("info", `▶ ${SOURCE_LABELS[source]}`);
        try {
          const items = source.startsWith("krisha")
            ? await crawlKrisha(source, params, ctx)
            : await crawlOlx(source, params, ctx);
          stats.perSource[source] = { fetched: items.length, kept: 0 };
          stats.fetched += items.length;
          raw.push(...items);
          ctx.log("ok", `${SOURCE_LABELS[source]}: собрано ${items.length}`);
        } catch (e) {
          stats.perSource[source] = { fetched: 0, kept: 0 };
          ctx.log("error", `${SOURCE_LABELS[source]}: ${(e as Error).message}`);
        }
      }

      // ── 2. Дедупликация ────────────────────────────────────────────────────
      const byId = new Map<string, Listing>();
      const byContent = new Set<string>();
      for (const l of raw) {
        if (byId.has(l.id)) continue;
        const key = dedupeKey(l);
        if (l.description.length > 40 && byContent.has(key)) {
          reject("duplicate");
          continue;
        }
        byContent.add(key);
        byId.set(l.id, l);
      }
      const unique = [...byId.values()];
      ctx.log("info", `Уникальных объявлений: ${unique.length} (дублей отброшено: ${stats.rejected.duplicate})`);

      // ── 3. Дешёвые фильтры ─────────────────────────────────────────────────
      const preFiltered: Listing[] = [];
      for (const l of unique) {
        if (l.price === null || l.price < params.priceMin || l.price > params.priceMax) {
          reject("price");
          continue;
        }
        if (l.rooms !== null && l.rooms > params.maxRooms) {
          reject("rooms");
          continue;
        }
        if (l.flags.daily) {
          reject("daily");
          continue;
        }
        if (params.excludeShared && l.flags.shared) {
          reject("shared");
          continue;
        }
        preFiltered.push(l);
      }
      ctx.log("info", `После фильтров по цене, комнатам и подселению осталось ${preFiltered.length}`);

      // ── 4. Грубые координаты по адресу ─────────────────────────────────────
      if (params.geocodeMissing) {
        const needGeo = preFiltered.filter((l) => l.lat === null);
        ctx.log("info", `Ищу адреса ${needGeo.length} объявлений в OpenStreetMap (≈1 запрос в секунду)`);
        let done = 0;
        for (const l of needGeo) {
          await locate(l);
          ctx.stage("Поиск адресов", ++done, needGeo.length);
        }
        ctx.log("ok", `Адрес определён у ${needGeo.filter((l) => l.lat !== null).length} из ${needGeo.length}`);
      }

      // ── 5. Радиус (с запасом — адрес пока приблизительный) ─────────────────
      const shortlist: Listing[] = [];
      for (const l of preFiltered) {
        const d = distanceTo(l, params);
        if (d !== null) {
          l.distanceKm = d;
          if (d > radiusFor(l, params) + RADIUS_SLACK_KM) {
            reject("distance");
            continue;
          }
        } else {
          l.lat = null;
          l.lon = null;
          l.geoSource = null;
          l.distanceKm = null;
          // Без координат оставляем только правый берег — там же, где университет.
          if (classifyBank(l.district) !== "right") {
            reject("no-geo");
            continue;
          }
        }
        shortlist.push(l);
      }
      ctx.log("info", `В зоне поиска: ${shortlist.length} объявлений`);

      // ── 6. Подробности Krisha только для короткого списка ──────────────────
      await enrichKrisha(shortlist, ctx);

      // ── 7. Финальный фильтр по точным данным ───────────────────────────────
      const kept: Listing[] = [];
      for (const l of shortlist) {
        if (l.rooms !== null && l.rooms > params.maxRooms) {
          reject("rooms");
          continue;
        }
        if (params.excludeShared && l.flags.shared) {
          reject("shared");
          continue;
        }
        const d = distanceTo(l, params);
        l.distanceKm = d;
        if (d !== null && d > radiusFor(l, params)) {
          reject("distance");
          continue;
        }
        if (d === null && classifyBank(l.district) !== "right") {
          reject("no-geo");
          continue;
        }
        kept.push(l);
        stats.perSource[l.source] = stats.perSource[l.source] ?? { fetched: 0, kept: 0 };
        stats.perSource[l.source].kept++;
      }

      stats.kept = kept.length;
      const exact = kept.filter((l) => l.distanceKm !== null).length;
      ctx.log(
        "ok",
        `В радиусе ${params.radiusKm} км от «${params.anchorLabel}»: ${exact}` +
          (kept.length - exact > 0
            ? `, плюс ${kept.length - exact} с неточным адресом на правом берегу`
            : ""),
      );

      // ── 8. ИИ ──────────────────────────────────────────────────────────────
      if (params.useAi && kept.length) {
        if (!hasGemini()) {
          ctx.log("warn", "Gemini не настроен — показываю варианты без ИИ-оценки");
        } else {
          ctx.log(
            "info",
            `Отдаю ${kept.length} объявлений на оценку Gemini — это самый долгий шаг, около минуты на каждые ${AI_BATCH}`,
          );
          let scored = 0;
          for (let i = 0; i < kept.length; i += AI_BATCH) {
            const batch = kept.slice(i, i + AI_BATCH);
            ctx.stage("ИИ-оценка", i, kept.length);
            try {
              const verdicts = await scoreBatch(batch, params);
              for (const l of batch) {
                const v = verdicts.get(l.id);
                if (v) {
                  l.ai = v;
                  scored++;
                }
              }
            } catch (e) {
              ctx.log("warn", `ИИ-батч не прошёл: ${(e as Error).message.slice(0, 160)}`);
              // Квота одна на весь проект: продолжать смысла нет, отдадим что есть.
              if (e instanceof GeminiQuotaError) break;
            }
            ctx.stage("ИИ-оценка", Math.min(i + AI_BATCH, kept.length), kept.length);
            if (i + AI_BATCH < kept.length) await sleep(AI_PAUSE_MS);
          }
          stats.aiScored = scored;
          ctx.log("ok", `ИИ оценил ${scored} объявлений`);
        }
      }

      // Без ИИ (или если пачка не прошла) сообщение всё равно должно быть готово.
      for (const l of kept) l.message = l.ai?.message || fallbackMessage(l);

      // ── 9. Сортировка ──────────────────────────────────────────────────────
      kept.sort((a, b) => {
        const sa = a.ai?.score ?? -1;
        const sb = b.ai?.score ?? -1;
        if (sa !== sb) return sb - sa;
        const da = a.distanceKm ?? 99;
        const db = b.distanceKm ?? 99;
        if (da !== db) return da - db;
        return (a.price ?? 0) - (b.price ?? 0);
      });

      // ── 10. Телефоны лучших вариантов ──────────────────────────────────────
      await enrichOlxPhones(kept, ctx, PHONE_PREFETCH);
      const withPhone = kept.filter((l) => l.phones.length).length;
      ctx.log(
        "ok",
        `Телефон сразу есть у ${withPhone} вариантов, остальные — по кнопке «Показать номер»`,
      );

      for (const l of kept) channel.push({ type: "listing", listing: l });

      await writeState({
        params,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        status: "done",
        error: null,
        stats,
        listings: kept,
      });

      channel.push({ type: "done", stats, count: kept.length });
    } catch (e) {
      channel.push({ type: "error", message: (e as Error).message });
    } finally {
      channel.close();
    }
  })();

  return channel;
}
