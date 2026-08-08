import "server-only";
import { cacheGet, cacheSet } from "../cache";
import { fetchText, sleep } from "../http";
import { cleanText, detectFlags } from "../normalize";
import { extractPhones, normalizePhone } from "../phone";
import type { Listing, SearchParams, SourceId } from "../types";
import type { CrawlContext } from "./krisha";

const ORIGIN = "https://www.olx.kz";

/**
 * OLX отдаёт всё состояние страницы прямо в HTML: `window.__PRERENDERED_STATE__ = "<json>"`.
 * Публичный REST-эндпоинт закрыт CloudFront, а этот путь работает со обычными заголовками.
 */
function extractState(html: string): Record<string, unknown> | null {
  const marker = html.indexOf("__PRERENDERED_STATE__");
  if (marker < 0) return null;

  const open = html.indexOf('"', marker);
  if (open < 0) return null;

  let i = open + 1;
  while (i < html.length) {
    if (html[i] === "\\") {
      i += 2;
      continue;
    }
    if (html[i] === '"') break;
    i++;
  }

  try {
    const literal = JSON.parse(html.slice(open, i + 1)) as string;
    return JSON.parse(literal) as Record<string, unknown>;
  } catch {
    return null;
  }
}

interface OlxAd {
  id: number;
  title: string;
  description: string;
  url: string;
  createdTime?: string;
  lastRefreshTime?: string;
  isBusiness?: boolean;
  map?: { lat?: number; lon?: number; zoom?: number; radius?: number; show_detailed?: boolean };
  location?: { cityName?: string; districtName?: string };
  price?: { regularPrice?: { value?: number } };
  photos?: Array<string | { link?: string }>;
  params?: Array<{ key: string; name: string; value: unknown; normalizedValue?: unknown }>;
  user?: { name?: string; company_name?: string };
}

interface OlxPage {
  ads: OlxAd[];
  totalPages: number;
  totalElements: number;
}

function readPage(state: Record<string, unknown> | null): OlxPage | null {
  const listing = (state as { listing?: { listing?: unknown } } | null)?.listing?.listing as
    | { ads?: OlxAd[]; totalPages?: number; totalElements?: number }
    | undefined;
  if (!listing?.ads) return null;
  return {
    ads: listing.ads,
    totalPages: listing.totalPages ?? 1,
    totalElements: listing.totalElements ?? listing.ads.length,
  };
}

function paramValue(ad: OlxAd, key: string): string | null {
  const p = ad.params?.find((x) => x.key === key);
  if (!p) return null;
  if (typeof p.value === "string") return p.value;
  if (typeof p.value === "number") return String(p.value);
  return null;
}

function photoUrl(ad: OlxAd): string | null {
  const first = ad.photos?.[0];
  if (!first) return null;
  const raw = typeof first === "string" ? first : (first.link ?? null);
  if (!raw) return null;
  // OLX отдаёт шаблон вида `.../image;s={width}x{height}`.
  return raw.replace("{width}", "600").replace("{height}", "400");
}

function roomsOf(ad: OlxAd): number | null {
  const raw = paramValue(ad, "kolichestvokomnat");
  if (raw) {
    const n = Number(String(raw).match(/\d+/)?.[0]);
    if (Number.isFinite(n)) return n;
  }
  const planning = paramValue(ad, "planirovka");
  if (planning && /студи/i.test(planning)) return 1;
  const m = ad.title.match(/(\d+)\s*-?\s*(?:х|x)?\s*комн/i);
  if (m) return Number(m[1]);
  if (/студи/i.test(ad.title)) return 1;
  return null;
}

function areaOf(ad: OlxAd): number | null {
  const raw = paramValue(ad, "obshayaploshad");
  if (!raw) return null;
  const n = Number(String(raw).replace(",", ".").match(/[\d.]+/)?.[0]);
  return Number.isFinite(n) ? n : null;
}

function sellerOf(ad: OlxAd): "owner" | "agent" | null {
  const type = paramValue(ad, "tipsobstvennosti");
  if (type && /хозя|собственник/i.test(type)) return "owner";
  if (type && /агент|посредник|риелт|риэлт/i.test(type)) return "agent";
  if (ad.user?.company_name) return "agent";
  return ad.isBusiness ? "agent" : null;
}

/**
 * Координаты у OLX — центроид района (десяток объявлений с одинаковой точкой),
 * поэтому за настоящую геометку считаем только детальную карту.
 */
function preciseCoords(ad: OlxAd): { lat: number; lon: number } | null {
  const m = ad.map;
  if (!m || typeof m.lat !== "number" || typeof m.lon !== "number") return null;
  const precise = m.show_detailed === true || (m.zoom ?? 0) >= 14 || (m.radius ?? 99) <= 1;
  return precise ? { lat: m.lat, lon: m.lon } : null;
}

function listUrl(section: "arenda-kvartiry" | "arenda-komnaty", p: SearchParams, page: number): string {
  const q = new URLSearchParams();
  q.set("search[filter_float_price:from]", String(p.priceMin));
  q.set("search[filter_float_price:to]", String(p.priceMax));
  q.set("search[order]", "created_at:desc");
  if (page > 1) q.set("page", String(page));
  return `${ORIGIN}/nedvizhimost/${section}/astana/?${q.toString()}`;
}

export async function crawlOlx(
  source: SourceId,
  params: SearchParams,
  ctx: CrawlContext,
): Promise<Listing[]> {
  const section = source === "olx-komnaty" ? "arenda-komnaty" : "arenda-kvartiry";
  const seen = new Set<number>();
  const listings: Listing[] = [];

  for (let page = 1; page <= params.maxPages; page++) {
    const url = listUrl(section, params, page);
    let html: string;
    try {
      html = await fetchText(url);
    } catch (e) {
      ctx.log("warn", `OLX /${section}: страница ${page} не открылась (${(e as Error).message})`);
      break;
    }

    const parsed = readPage(extractState(html));
    if (!parsed) {
      ctx.log("warn", `OLX /${section}: не удалось разобрать страницу ${page}`);
      break;
    }

    let added = 0;
    for (const ad of parsed.ads) {
      if (seen.has(ad.id)) continue;
      seen.add(ad.id);

      const city = ad.location?.cityName ?? "";
      if (city && !/астана|нур-султан|нұр-сұлтан|astana/i.test(city)) continue;

      const description = cleanText(ad.description);
      const district = ad.location?.districtName?.trim() || null;
      const address = [district, paramValue(ad, "adres")].filter(Boolean).join(", ");
      const coords = preciseCoords(ad);
      const paramsText = (ad.params ?? [])
        .filter((p) => typeof p.value === "string" || typeof p.value === "number")
        .map((p) => `${p.name}: ${p.value}`)
        .join("; ");

      listings.push({
        id: `${source}:${ad.id}`,
        source,
        externalId: String(ad.id),
        url: ad.url.startsWith("http") ? ad.url : ORIGIN + ad.url,
        title: ad.title,
        price: ad.price?.regularPrice?.value ?? null,
        description: cleanText([description, paramsText].filter(Boolean).join("\n")),
        address: address || (ad.location?.cityName ?? "Астана"),
        district,
        rooms: roomsOf(ad),
        area: areaOf(ad),
        floor: paramValue(ad, "etazh"),
        lat: coords?.lat ?? null,
        lon: coords?.lon ?? null,
        geoSource: coords ? "listing" : null,
        distanceKm: null,
        photo: photoUrl(ad),
        photosCount: ad.photos?.length ?? 0,
        sellerType: sellerOf(ad),
        // В тексте OLX номера маскирует, настоящий забираем отдельным запросом.
        phones: extractPhones(description),
        phoneHint: null,
        postedAt: ad.lastRefreshTime ?? ad.createdTime ?? null,
        message: "",
        flags: detectFlags(ad.title, description, address, paramsText),
        ai: null,
      });
      added++;
    }

    ctx.log("info", `OLX /${section}: страница ${page} — ${added} объявлений (всего в выдаче ${parsed.totalElements})`);
    if (added === 0 || page >= parsed.totalPages) break;
    await sleep(400);
  }

  return listings;
}

const PHONE_TTL = 3 * 24 * 60 * 60 * 1000;
/**
 * Ручка телефона у OLX защищена от массовых обращений: полсотни запросов подряд
 * ловят «обнаружена подозрительная активность» и перестают отвечать вообще.
 * Поэтому пауза как у живого человека и жёсткий лимит на прогон.
 */
const PHONE_DELAY_MS = 2000;

export class OlxBlockedError extends Error {
  constructor() {
    super("OLX временно не отдаёт номера (защита от массовых запросов)");
    this.name = "OlxBlockedError";
  }
}

/** Один номер — та же ручка, что дёргает кнопка «Показать номер» на сайте. */
export async function fetchOlxPhone(externalId: string, adUrl: string): Promise<string[]> {
  const cached = await cacheGet<string[]>("olx-phones", externalId, PHONE_TTL);
  if (cached) return cached;

  const body = await fetchText(`${ORIGIN}/api/v1/offers/${externalId}/limited-phones/`, {
    headers: { Accept: "application/json", Referer: adUrl },
    retries: 0,
    timeoutMs: 15_000,
  });

  const data = JSON.parse(body) as { data?: { phones?: string[] } };
  const phones = (data.data?.phones ?? [])
    .map((p) => normalizePhone(p))
    .filter((p): p is string => Boolean(p));

  if (phones.length) await cacheSet("olx-phones", externalId, phones);
  return phones;
}

/** Забирает номера только у первых `limit` вариантов — остальные тянутся по кнопке. */
export async function enrichOlxPhones(
  listings: Listing[],
  ctx: CrawlContext,
  limit: number,
): Promise<void> {
  const targets = listings
    .filter((l) => l.source.startsWith("olx") && l.phones.length === 0)
    .slice(0, limit);
  if (!targets.length) return;

  ctx.log("info", `OLX: беру телефоны для ${targets.length} лучших вариантов`);
  let done = 0;
  let found = 0;

  for (const l of targets) {
    try {
      l.phones = await fetchOlxPhone(l.externalId, l.url);
      if (l.phones.length) found++;
      else l.phoneHint = "OLX не показал номер — откройте объявление";
    } catch (e) {
      const blocked = /400|подозрительн/i.test((e as Error).message);
      l.phoneHint = blocked
        ? "OLX притормозил выдачу номеров — нажмите «Показать номер» чуть позже"
        : "Не удалось получить номер";
      if (blocked) {
        ctx.log("warn", "OLX перестал отдавать номера — остальные подтянутся по кнопке в карточке");
        break;
      }
    }
    ctx.stage("OLX: телефоны", ++done, targets.length);
    await sleep(PHONE_DELAY_MS);
  }

  ctx.log("ok", `OLX: номера получены у ${found} из ${targets.length}`);
}
