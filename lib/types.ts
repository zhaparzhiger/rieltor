/** Общие типы поиска жилья. Клиент и сервер используют одни и те же формы. */

export type SourceId =
  | "krisha-kvartiry"
  | "krisha-komnaty"
  | "olx-kvartiry"
  | "olx-komnaty";

export const SOURCE_LABELS: Record<SourceId, string> = {
  "krisha-kvartiry": "Krisha · аренда квартир",
  "krisha-komnaty": "Krisha · аренда комнат",
  "olx-kvartiry": "OLX · аренда квартир",
  "olx-komnaty": "OLX · аренда комнат",
};

/** Настройки одного прогона парсинга — приходят с фронта. */
export interface SearchParams {
  /** Ориентир, от которого считаем расстояние (по умолчанию TAU). */
  anchorLat: number;
  anchorLon: number;
  anchorLabel: string;
  /** Радиус в километрах. */
  radiusKm: number;
  priceMin: number;
  priceMax: number;
  /** Максимум комнат (студия считается за одну). */
  maxRooms: number;
  sources: SourceId[];
  /** Сколько страниц выдачи листать на источник. */
  maxPages: number;
  /** Выкидывать объявления с явными признаками подселения. */
  excludeShared: boolean;
  /** Догеокодировать адреса без координат через OpenStreetMap. */
  geocodeMissing: boolean;
  /** Прогонять итоговую выборку через Gemini. */
  useAi: boolean;
}

export const DEFAULT_PARAMS: SearchParams = {
  // Turan Astana University, ул. Ы. Дукенулы, 29 (правый берег, Сарыарка).
  anchorLat: 51.181568,
  anchorLon: 71.43244,
  anchorLabel: "Turan Astana University (Дукенулы, 29)",
  radiusKm: 3,
  priceMin: 60_000,
  priceMax: 85_000,
  maxRooms: 1,
  sources: ["krisha-kvartiry", "krisha-komnaty", "olx-kvartiry", "olx-komnaty"],
  maxPages: 6,
  excludeShared: true,
  geocodeMissing: true,
  useAi: true,
};

/** Почему объявление отсеяли — показываем в статистике прогона. */
export type RejectReason =
  | "price"
  | "rooms"
  | "distance"
  | "no-geo"
  | "shared"
  | "duplicate"
  | "daily";

/** Нормализованное объявление. */
export interface Listing {
  /** Стабильный ключ: `${source}:${externalId}`. */
  id: string;
  source: SourceId;
  externalId: string;
  url: string;
  title: string;
  price: number | null;
  /** Текст описания, обрезанный до разумного размера. */
  description: string;
  address: string;
  district: string | null;
  rooms: number | null;
  area: number | null;
  floor: string | null;
  lat: number | null;
  lon: number | null;
  /**
   * `listing` — точка из самого объявления, `geocoded` — нашли дом по адресу,
   * `approx` — попали только в улицу или квартал.
   */
  geoSource: "listing" | "geocoded" | "approx" | null;
  distanceKm: number | null;
  photo: string | null;
  photosCount: number;
  /** «Хозяин» / «Агент» / null, если источник не сообщает. */
  sellerType: "owner" | "agent" | null;
  /** Номера в формате wa.me (77XXXXXXXXX). */
  phones: string[];
  /** Почему номера нет: «+7 701 …, полный номер только под логином на Krisha». */
  phoneHint: string | null;
  postedAt: string | null;
  /** Готовый текст первого сообщения в WhatsApp: от ИИ либо по шаблону. */
  message: string;
  /** Эвристики, посчитанные без ИИ. */
  flags: ListingFlags;
  ai: AiVerdict | null;
}

export interface ListingFlags {
  /** Похоже на подселение / поиск соседа. */
  shared: boolean;
  /** Посуточная аренда. */
  daily: boolean;
  /** Общежитие / секционка. */
  hostel: boolean;
  /** Явно указано «без подселения» / «отдельная квартира». */
  soloFriendly: boolean;
  /** Совпало по слову «студент». */
  studentFriendly: boolean;
  /** Сработавшие ключевые слова — для объяснения пользователю. */
  matched: string[];
}

export interface AiVerdict {
  /** 0–100, насколько вариант подходит под запрос. */
  score: number;
  verdict: string;
  pros: string[];
  cons: string[];
  /** Риск того, что это подселение/комната с соседями: low | medium | high. */
  sharedRisk: "low" | "medium" | "high";
  /** Риск скама / некорректного объявления. */
  scamRisk: "low" | "medium" | "high";
  /** Готовый текст первого сообщения хозяину в WhatsApp. */
  message: string;
}

/** Итог прогона, который лежит в data/state.json. */
export interface RunState {
  params: SearchParams;
  startedAt: string;
  finishedAt: string | null;
  status: "idle" | "running" | "done" | "error";
  error: string | null;
  stats: RunStats;
  listings: Listing[];
}

export interface RunStats {
  fetched: number;
  kept: number;
  rejected: Record<RejectReason, number>;
  perSource: Record<string, { fetched: number; kept: number }>;
  aiScored: number;
}

export function emptyStats(): RunStats {
  return {
    fetched: 0,
    kept: 0,
    rejected: { price: 0, rooms: 0, distance: 0, "no-geo": 0, shared: 0, duplicate: 0, daily: 0 },
    perSource: {},
    aiScored: 0,
  };
}

/** Событие прогресса, которое сервер шлёт в SSE. */
export type ProgressEvent =
  | { type: "log"; level: "info" | "warn" | "error" | "ok"; message: string }
  | { type: "stage"; stage: string; done: number; total: number }
  | { type: "listing"; listing: Listing }
  | { type: "done"; stats: RunStats; count: number }
  | { type: "error"; message: string };
