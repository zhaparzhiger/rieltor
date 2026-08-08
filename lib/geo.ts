import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import { env } from "./env";
import { fetchText, sleep } from "./http";

const EARTH_KM = 6371;

export function haversineKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.sqrt(a));
}

/** Грубая рамка Астаны — отбрасываем мусорные координаты вроде 0,0. */
export function insideAstana(lat: number, lon: number): boolean {
  return lat > 50.9 && lat < 51.35 && lon > 71.15 && lon < 71.8;
}

// ── геокодер ────────────────────────────────────────────────────────────────
// Nominatim просит не больше одного запроса в секунду, поэтому очередь строго
// последовательная, а результаты (в том числе промахи) кэшируются на диск.

/**
 * `exact` — попали в конкретный дом, `approx` — только в улицу или квартал.
 * Точка улицы в Астане может уехать на километр, поэтому в фильтре по радиусу
 * такие адреса получают отдельный допуск.
 */
export type GeoPrecision = "exact" | "approx";
type GeoPoint = { lat: number; lon: number; precision: GeoPrecision } | null;

const memory = new Map<string, GeoPoint>();
let diskLoaded = false;
let chain: Promise<unknown> = Promise.resolve();

function cacheFile(): string {
  return path.resolve(process.cwd(), env.dataDir, "geocache-v2.json");
}

async function loadCache(): Promise<void> {
  if (diskLoaded) return;
  diskLoaded = true;
  try {
    const raw = await fs.readFile(cacheFile(), "utf8");
    for (const [k, v] of Object.entries(JSON.parse(raw) as Record<string, GeoPoint>)) {
      memory.set(k, v);
    }
  } catch {
    /* кэша ещё нет — не страшно */
  }
}

let saveTimer: NodeJS.Timeout | null = null;
function scheduleSave(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try {
      await fs.mkdir(path.dirname(cacheFile()), { recursive: true });
      await fs.writeFile(cacheFile(), JSON.stringify(Object.fromEntries(memory)), "utf8");
    } catch {
      /* кэш — не критичная штука */
    }
  }, 1500);
}

/**
 * Название района геокодер тоже найдёт — и вернёт центр полигона.
 * Такая «точка» выглядит как настоящая, но врёт на километры, поэтому
 * запрос без номера дома и без имени ЖК считаем бесполезным.
 */
/** Административные районы Астаны: их центроид ничего не говорит о доме. */
const ADMIN_DISTRICT =
  /^(сарыарк|алматин|есил|есиль|байконур|байқоңыр|нурин|нұра|нура)[а-яё]*(\s*(район|р-н|ауданы))?$/i;

export function isUsefulGeoQuery(query: string): boolean {
  const core = query.replace(/,\s*астана\s*$/i, "").trim();
  if (core.length < 4) return false;
  if (/^(астана|нур-султан|казахстан|правый берег|левый берег)$/i.test(core)) return false;
  if (ADMIN_DISTRICT.test(core)) return false;
  // «Сарыаркинский район» и прочие административные единицы без номера дома.
  if (/(район|р-н|ауданы)/i.test(core) && !/\d/.test(core)) return false;
  return true;
}

/**
 * Приводим адрес из объявления к виду, который понимает OSM:
 * «Алматы р-н, Айманова 11 — Дукенулы» → «Айманова 11, Астана».
 */
export function normalizeAddress(raw: string): string | null {
  let s = raw
    .replace(/^[^,]*(р-н|район)[,\s]*/i, "")
    .replace(/\s*—\s*.*$/, "")
    .replace(/\b(жк|ЖК)\s+«[^»]*»/g, "")
    // «Ж.Жабаева 32а» → «Жабаева 32а»: инициал сбивает геокодер.
    .replace(/(^|\s)[А-ЯЁӘҒҚҢӨҰҮҺІA-Z]\.\s*/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  s = s.replace(/^,+|,+$/g, "").trim();
  if (s.length < 4) return null;
  if (!/астан/i.test(s)) s = `${s}, Астана`;
  return isUsefulGeoQuery(s) ? s : null;
}

export async function geocode(address: string): Promise<GeoPoint> {
  await loadCache();
  const key = address.toLowerCase();
  if (memory.has(key)) return memory.get(key)!;

  // Ставим запрос в общую очередь: один поход в Nominatim за раз + пауза.
  const task = chain.then(async (): Promise<GeoPoint> => {
    if (memory.has(key)) return memory.get(key)!;
    let point: GeoPoint = null;
    try {
      const url =
        "https://nominatim.openstreetmap.org/search?format=json&limit=3&countrycodes=kz&q=" +
        encodeURIComponent(address);
      const body = await fetchText(url, {
        headers: {
          "User-Agent": "rieltor-astana-search/1.0 (personal student housing tool)",
          Accept: "application/json",
        },
        retries: 1,
        timeoutMs: 15_000,
      });
      const arr = JSON.parse(body) as Array<{
        lat: string;
        lon: string;
        class?: string;
        type?: string;
      }>;

      for (const hit of arr) {
        const lat = Number(hit.lat);
        const lon = Number(hit.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon) || !insideAstana(lat, lon)) continue;

        // Дом или адресная точка — то, что нужно.
        if (hit.class === "building" || hit.class === "place" || hit.type === "house") {
          point = { lat, lon, precision: "exact" };
          break;
        }
        // Улица без дома: годится как ориентир.
        if (hit.class === "highway" && !point) {
          point = { lat, lon, precision: "approx" };
        }
        // Кафе и магазины с похожим названием — мимо: «Коктал» находит кофейню.
      }
    } catch {
      point = null;
    }
    memory.set(key, point);
    scheduleSave();
    await sleep(1100);
    return point;
  });

  chain = task.catch(() => null);
  return task;
}
