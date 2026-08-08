import "server-only";
import * as cheerio from "cheerio";
import { cacheGet, cacheSet } from "../cache";
import { env } from "../env";
import { fetchText, sleep } from "../http";
import { cleanText, detectFlags, parseKrishaTitle, parsePrice } from "../normalize";
import { extractPhones, normalizePhone } from "../phone";
import type { Listing, SearchParams, SourceId } from "../types";

const ORIGIN = "https://krisha.kz";
const LIST_TTL = 20 * 60 * 1000;
const DETAIL_TTL = 7 * 24 * 60 * 60 * 1000;
/** Пауза между обращениями к krisha: сайт режет IP за всплеск запросов. */
const POLITE_DELAY = 900;

export interface CrawlContext {
  log: (level: "info" | "warn" | "error" | "ok", message: string) => void;
  stage: (stage: string, done: number, total: number) => void;
}

interface Card {
  externalId: string;
  url: string;
  title: string;
  price: number | null;
  address: string;
  preview: string;
  photo: string | null;
  sellerType: "owner" | "agent" | null;
  postedAt: string | null;
  city: string | null;
}

/** Со второй страницы Krisha подмешивает выдачу других городов. */
function isAstana(city: string | null): boolean {
  if (!city) return false;
  return /астана|нур-султан|нұр-сұлтан|astana/i.test(city);
}

/** В JSON объявления район приходит слагом вида `Saryarka_r-n`. */
const DISTRICT_NAMES: Array<[RegExp, string]> = [
  [/almaty/i, "Алматы р-н"],
  [/saryark/i, "Сарыарка р-н"],
  [/baikonur|baykonyr|baikonyr/i, "Байконыр р-н"],
  [/esil|yesil/i, "Есиль р-н"],
  [/nura/i, "Нура р-н"],
];

function prettyDistrict(raw: string | null): string | null {
  if (!raw) return null;
  for (const [re, name] of DISTRICT_NAMES) if (re.test(raw)) return name;
  return raw.replace(/_/g, " ");
}

function listUrl(section: "kvartiry" | "komnaty", p: SearchParams, page: number): string {
  const q = new URLSearchParams();
  q.set("das[price][from]", String(p.priceMin));
  q.set("das[price][to]", String(p.priceMax));
  // В разделе komnaty единица сдачи и так одна комната.
  if (section === "kvartiry" && p.maxRooms === 1) q.set("das[live.rooms]", "1");
  if (page > 1) q.set("page", String(page));
  return `${ORIGIN}/arenda/${section}/astana/?${q.toString()}`;
}

function parseCards(html: string): Card[] {
  const $ = cheerio.load(html);
  const cards: Card[] = [];

  $("div.a-card[data-id]").each((_, el) => {
    const node = $(el);
    const externalId = node.attr("data-id")?.trim();
    if (!externalId) return;

    const titleEl = node.find("a.a-card__title").first();
    const href = titleEl.attr("href") ?? `/a/show/${externalId}`;
    const ownerLabel = node.find(".label-user-owner").length > 0;
    const ownerText = node.find(".a-card__owner").text();

    cards.push({
      externalId,
      url: href.startsWith("http") ? href : ORIGIN + href,
      title: titleEl.text().trim(),
      price: parsePrice(node.find(".a-card__price").first().text()),
      address: node.find(".a-card__subtitle").first().text().trim(),
      preview: node.find(".a-card__text-preview").first().text().trim(),
      photo:
        node.find("picture").first().attr("data-full-src") ??
        node.find("picture img").first().attr("src") ??
        null,
      sellerType: ownerLabel
        ? "owner"
        : /агент|риелт|риэлт|компан/i.test(ownerText)
          ? "agent"
          : null,
      postedAt: node.find(".a-card__stats-item").eq(1).text().trim() || null,
      city: node.find(".a-card__stats-item").eq(0).text().trim() || null,
    });
  });

  return cards;
}

/** Достаём объект `window.data = {...};` со страницы объявления. */
function extractWindowData(html: string): Record<string, unknown> | null {
  const start = html.indexOf("window.data = ");
  if (start < 0) return null;
  const open = html.indexOf("{", start);
  if (open < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = open; i < html.length; i++) {
    const ch = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) {
      try {
        return JSON.parse(html.slice(open, i + 1)) as Record<string, unknown>;
      } catch {
        return null;
      }
    }
  }
  return null;
}

interface Detail {
  lat: number | null;
  lon: number | null;
  district: string | null;
  rooms: number | null;
  area: number | null;
  description: string;
  addressTitle: string | null;
  sellerType: "owner" | "agent" | null;
  photosCount: number;
  params: string;
  /** Публичная «маска» номера, например «+7 701 ». */
  phonePreview: string | null;
  phones: string[];
}

/**
 * Полный номер Krisha отдаёт только авторизованным. Со своей сессией
 * (KRISHA_COOKIE) дёргаем ту же ручку, что и кнопка «Показать телефон».
 */
export async function fetchKrishaPhones(id: string): Promise<string[]> {
  if (!env.krishaCookie) return [];
  try {
    const body = await fetchText(`${ORIGIN}/a/ajaxPhones?id=${id}`, {
      headers: {
        Accept: "application/json, text/javascript, */*; q=0.01",
        "X-Requested-With": "XMLHttpRequest",
        Referer: `${ORIGIN}/a/show/${id}`,
        Cookie: env.krishaCookie,
      },
      retries: 0,
      timeoutMs: 15_000,
    });
    const data = JSON.parse(body) as { phones?: string[]; error?: string };
    return (data.phones ?? [])
      .map((p) => normalizePhone(p))
      .filter((p): p is string => Boolean(p));
  } catch {
    return [];
  }
}

async function loadDetail(id: string, url: string): Promise<Detail> {
  const cached = await cacheGet<Detail>("krisha-detail-v2", id, DETAIL_TTL);
  if (cached) return cached;

  const html = await fetchText(url, {
    headers: { Referer: `${ORIGIN}/arenda/kvartiry/astana/` },
    retries: 1,
    timeoutMs: 20_000,
  });
  const $ = cheerio.load(html);

  const params = $(".offer__parameters dl")
    .map((_, dl) => {
      const dt = $(dl).find("dt").text().trim();
      const dd = $(dl).find("dd").text().trim();
      return dt && dd ? `${dt}: ${dd}` : "";
    })
    .get()
    .filter(Boolean)
    .join("; ");

  const advert = ((extractWindowData(html)?.advert ?? {}) as Record<string, unknown>);
  const map = (advert.map ?? {}) as { lat?: number; lon?: number };
  const address = (advert.address ?? {}) as { district?: string };
  const preview = html.match(/"phonePreview":"([^"]*)"/)?.[1]?.trim() || null;

  const detail: Detail = {
    lat: typeof map.lat === "number" ? map.lat : null,
    lon: typeof map.lon === "number" ? map.lon : null,
    district: typeof address.district === "string" ? address.district : null,
    rooms: typeof advert.rooms === "number" ? advert.rooms : null,
    area: typeof advert.square === "number" ? advert.square : null,
    description: cleanText($(".js-description").first().text()),
    addressTitle: typeof advert.addressTitle === "string" ? advert.addressTitle : null,
    sellerType: advert.userType === "owner" ? "owner" : advert.userType ? "agent" : null,
    photosCount: Array.isArray(advert.photos) ? advert.photos.length : 0,
    params,
    phonePreview: preview,
    phones: [],
  };

  const fromText = extractPhones(detail.description, params);
  detail.phones = fromText.length ? fromText : await fetchKrishaPhones(id);

  await cacheSet("krisha-detail-v2", id, detail);
  return detail;
}

/**
 * Первый проход: только выдача. Детальные страницы не трогаем — их тянем
 * позже и лишь для объявлений, прошедших фильтр по радиусу.
 */
export async function crawlKrisha(
  source: SourceId,
  params: SearchParams,
  ctx: CrawlContext,
): Promise<Listing[]> {
  const section = source === "krisha-komnaty" ? "komnaty" : "kvartiry";
  const seen = new Set<string>();
  const cards: Card[] = [];

  /** Возвращает карточки страницы; пустые ответы не кэшируем — это обычно заглушка. */
  async function loadPage(page: number): Promise<Card[] | null> {
    const url = listUrl(section, params, page);
    const cached = await cacheGet<string>("krisha-list", url, LIST_TTL);
    if (cached) return parseCards(cached);

    let html: string;
    try {
      html = await fetchText(url, { retries: 2, timeoutMs: 20_000 });
    } catch (e) {
      ctx.log(
        "warn",
        `Krisha /${section}: страница ${page} не открылась (${(e as Error).message}). ` +
          "Скорее всего сайт временно режет частые запросы — подождите пару минут.",
      );
      return null;
    }
    await sleep(POLITE_DELAY);

    const parsed = parseCards(html);
    if (parsed.length) await cacheSet("krisha-list", url, html);
    return parsed;
  }

  for (let page = 1; page <= params.maxPages; page++) {
    let parsed = await loadPage(page);
    if (parsed === null) break;

    // Пустая страница посреди выдачи — почти всегда заглушка антибота, а не конец списка.
    if (parsed.length === 0 && page > 1) {
      await sleep(2500);
      parsed = await loadPage(page);
      if (!parsed?.length) {
        ctx.log("warn", `Krisha /${section}: страница ${page} пришла пустой, останавливаюсь`);
        break;
      }
    }
    if (parsed.length === 0) break;

    const batch = parsed.filter((c) => !seen.has(c.externalId));
    for (const c of batch) seen.add(c.externalId);

    const astana = batch.filter((c) => isAstana(c.city));
    cards.push(...astana);
    const foreign = batch.length - astana.length;
    ctx.log(
      "info",
      `Krisha /${section}: страница ${page} — ${astana.length} объявлений` +
        (foreign ? ` (${foreign} из других городов пропущено)` : ""),
    );

    if (batch.length === 0) break;
    // Пошли чужие города — значит выдача по Астане закончилась.
    if (astana.length === 0) break;
  }

  const listings: Listing[] = [];
  for (const card of cards) {
    const fromTitle = parseKrishaTitle(card.title);
    listings.push({
      id: `${source}:${card.externalId}`,
      source,
      externalId: card.externalId,
      url: card.url,
      title: card.title,
      price: card.price,
      description: cleanText(card.preview),
      address: card.address,
      district: card.address.match(/^([^,]*р-н)/)?.[1] ?? null,
      rooms: fromTitle.rooms ?? (section === "komnaty" ? 1 : null),
      area: fromTitle.area,
      floor: fromTitle.floor,
      lat: null,
      lon: null,
      geoSource: null,
      distanceKm: null,
      photo: card.photo,
      photosCount: card.photo ? 1 : 0,
      sellerType: card.sellerType,
      phones: [],
      phoneHint: null,
      postedAt: card.postedAt,
      message: "",
      flags: detectFlags(card.title, card.preview, card.address),
      ai: null,
    });
  }

  return listings;
}

/**
 * Второй проход: точные координаты, полное описание и параметры.
 * Идём последовательно с паузой и останавливаемся, если сайт начал отбиваться.
 */
export async function enrichKrisha(listings: Listing[], ctx: CrawlContext): Promise<void> {
  const targets = listings.filter((l) => l.source.startsWith("krisha"));
  if (!targets.length) return;

  ctx.log("info", `Krisha: догружаю подробности по ${targets.length} объявлениям`);
  let failures = 0;
  let done = 0;

  for (const l of targets) {
    try {
      const detail = await loadDetail(l.externalId, l.url);
      failures = 0;

      if (detail.lat !== null && detail.lon !== null) {
        l.lat = detail.lat;
        l.lon = detail.lon;
        l.geoSource = "listing";
      }
      if (detail.description) {
        l.description = cleanText([detail.description, detail.params].filter(Boolean).join("\n"));
      }
      // Красивое имя района подставляем при чтении: в кэше лежит слаг из JSON.
      const district = prettyDistrict(detail.district);
      if (detail.addressTitle) {
        l.address = [district, detail.addressTitle].filter(Boolean).join(", ");
      }
      l.district = district ?? l.district;
      l.rooms = detail.rooms ?? l.rooms;
      l.area = detail.area ?? l.area;
      l.sellerType = detail.sellerType ?? l.sellerType;
      l.photosCount = detail.photosCount || l.photosCount;
      l.phones = detail.phones ?? [];
      l.phoneHint = l.phones.length
        ? null
        : detail.phonePreview
          ? `${detail.phonePreview}… — Krisha показывает полный номер только после входа в аккаунт`
          : "Номер откроется на странице объявления после входа в аккаунт Krisha";
      l.flags = detectFlags(l.title, l.description, l.address, detail.params);
    } catch {
      failures++;
      if (failures >= 4) {
        ctx.log(
          "warn",
          "Krisha перестала отвечать — оставляю данные из выдачи. " +
            "Повторите прогон через 5–10 минут, уже загруженное сохранено в кэш.",
        );
        break;
      }
    }
    ctx.stage("Krisha: подробности", ++done, targets.length);
    await sleep(POLITE_DELAY);
  }
}
