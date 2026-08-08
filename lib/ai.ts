import "server-only";
import { GoogleGenAI, Type } from "@google/genai";
import { env, hasGemini } from "./env";
import type { AiVerdict, Listing, SearchParams } from "./types";

export class GeminiNotConfiguredError extends Error {
  constructor() {
    super(
      "Gemini не настроен: пропишите GEMINI_API_KEY в .env.local либо включите Vertex " +
        "(GEMINI_USE_VERTEX=1 + GOOGLE_CLOUD_PROJECT + GOOGLE_APPLICATION_CREDENTIALS).",
    );
    this.name = "GeminiNotConfiguredError";
  }
}

let client: GoogleGenAI | null = null;

function genAI(): GoogleGenAI {
  if (!hasGemini()) throw new GeminiNotConfiguredError();
  if (!client) {
    const httpOptions = { timeout: CALL_TIMEOUT_MS };
    client = env.useVertex
      ? new GoogleGenAI({
          vertexai: true,
          project: env.googleCloudProject,
          location: env.googleCloudLocation,
          httpOptions,
        })
      : new GoogleGenAI({ apiKey: env.geminiApiKey, httpOptions });
  }
  return client;
}

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    items: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.STRING },
          score: { type: Type.INTEGER },
          verdict: { type: Type.STRING },
          pros: { type: Type.ARRAY, items: { type: Type.STRING } },
          cons: { type: Type.ARRAY, items: { type: Type.STRING } },
          sharedRisk: { type: Type.STRING, enum: ["low", "medium", "high"] },
          scamRisk: { type: Type.STRING, enum: ["low", "medium", "high"] },
          message: { type: Type.STRING },
        },
        required: ["id", "score", "verdict", "pros", "cons", "sharedRisk", "scamRisk", "message"],
      },
    },
  },
  required: ["items"],
} as const;

function systemPrompt(p: SearchParams): string {
  return [
    "Ты помогаешь студенту, который переезжает в Астану и снимает жильё на длительный срок.",
    "",
    "Что ему нужно:",
    `- жить одному, без подселения и без соседей по квартире;`,
    `- одна комната (1-комнатная квартира или студия), максимум ${p.maxRooms} комн.;`,
    `- бюджет ${p.priceMin.toLocaleString("ru-RU")}–${p.priceMax.toLocaleString("ru-RU")} ₸ в месяц, чем дешевле — тем лучше;`,
    `- пешая доступность до «${p.anchorLabel}», радиус до ${p.radiusKm} км;`,
    "- долгосрочная аренда, не посуточная.",
    "",
    "Оцени каждое объявление по шкале 0–100:",
    "- 85–100: полностью подходит, отдельное жильё в бюджете и рядом с университетом;",
    "- 60–84: подходит с оговорками (дальше, дороже, мало данных, агент вместо хозяина);",
    "- 30–59: сомнительно (общежитие/секционка, непонятный адрес, странная цена);",
    "- 0–29: не подходит (подселение, койко-место, посуточно, другой город/берег).",
    "",
    "Правила:",
    "- Подселение, «ищу соседку/соседа», койко-место, «будем жить вдвоём» → score не выше 20, sharedRisk = high.",
    "- Посуточная и почасовая аренда → score не выше 15.",
    "- Цена сильно ниже рынка + мало фото + просьба о предоплате → scamRisk = high.",
    "- Если расстояние неизвестно, не выдумывай его: снижай оценку умеренно и напиши это в cons.",
    "- verdict — одна фраза на русском, до 120 символов, по делу, без воды.",
    "- pros и cons — до 3 пунктов, коротко, на русском.",
    "- Верни ровно по одному объекту на каждый переданный id.",
    "",
    "Поле message — готовый текст первого сообщения хозяину в WhatsApp:",
    "- на русском, на «вы», вежливо и по-человечески, без канцелярита и без смайликов;",
    "- 3–5 коротких предложений, до 400 символов;",
    "- поздороваться, сослаться на объявление (упомянуть адрес или цену из него);",
    "- представиться студентом, который переезжает в Астану и снимет надолго, жить будет один;",
    "- спросить самое важное именно для этого варианта: свободно ли ещё, входят ли коммунальные " +
      "в цену, какой депозит, и точно ли без подселения, если по тексту это неочевидно;",
    "- в конце спросить, когда можно посмотреть;",
    "- не выдумывать фактов, которых нет в объявлении, и не обещать денег вперёд.",
  ].join("\n");
}

function describe(l: Listing): string {
  const rows = [
    `id: ${l.id}`,
    `источник: ${l.source}`,
    `заголовок: ${l.title}`,
    `цена: ${l.price ? l.price.toLocaleString("ru-RU") + " ₸/мес" : "не указана"}`,
    `комнат: ${l.rooms ?? "не указано"}`,
    `площадь: ${l.area ? l.area + " м²" : "не указана"}`,
    `этаж: ${l.floor ?? "не указан"}`,
    `адрес: ${l.address || "не указан"}`,
    `расстояние до университета: ${l.distanceKm !== null ? l.distanceKm.toFixed(2) + " км" : "неизвестно"}`,
    `кто сдаёт: ${l.sellerType === "owner" ? "хозяин" : l.sellerType === "agent" ? "агент" : "неизвестно"}`,
    `фото: ${l.photosCount}`,
    l.flags.matched.length ? `сработавшие слова: ${l.flags.matched.join(", ")}` : "",
    `описание: ${l.description.slice(0, 900) || "нет"}`,
  ];
  return rows.filter(Boolean).join("\n");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Сколько ждём один ответ модели: без потолка зависший запрос вешает весь прогон. */
const CALL_TIMEOUT_MS = 120_000;

/** Своя гонка со временем: на отмену через abortSignal SDK полагаться нельзя. */
async function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Gemini не ответил за ${ms / 1000} с`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export class GeminiQuotaError extends Error {
  constructor() {
    super("Gemini упёрся в квоту проекта (429). Подождите минуту и запустите прогон снова.");
    this.name = "GeminiQuotaError";
  }
}

/**
 * Квота Vertex узкая, и на 429 SDK молча уходит в собственные повторы —
 * поэтому ограничиваем и время одного вызова, и число попыток.
 */
async function generateWithRetry(
  ai: GoogleGenAI,
  body: string,
  params: SearchParams,
  attempts = 3,
): Promise<string> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const res = await withDeadline(
        ai.models.generateContent({
          model: env.geminiModel,
          contents: `Объявления:\n\n${body}`,
          config: {
            systemInstruction: systemPrompt(params),
            temperature: 0.2,
            responseMimeType: "application/json",
            responseSchema: RESPONSE_SCHEMA as never,
          },
        }),
        CALL_TIMEOUT_MS,
      );
      return res.text ?? "";
    } catch (e) {
      const message = (e as Error).message ?? "";
      const throttled = /429|RESOURCE_EXHAUSTED|quota/i.test(message);
      const retriable = throttled || /не ответил|503|UNAVAILABLE|ETIMEDOUT|ECONNRESET/i.test(message);
      if (!retriable || attempt === attempts - 1) {
        throw throttled ? new GeminiQuotaError() : e;
      }
      await sleep(throttled ? 12_000 * (attempt + 1) : 4000 * (attempt + 1));
    }
  }
  return "";
}

function defaultMessage(listings: Listing[], id: string): string {
  const listing = listings.find((l) => l.id === id);
  return listing ? fallbackMessage(listing) : "";
}

/** Текст сообщения без ИИ — на случай, когда Gemini недоступен. */
export function fallbackMessage(l: Listing): string {
  const what = l.address ? `вариант по адресу ${l.address}` : "ваш вариант";
  const price = l.price ? ` за ${l.price.toLocaleString("ru-RU")} ₸` : "";
  return [
    `Здравствуйте! Пишу по объявлению — ${what}${price}.`,
    "Я студент, переезжаю в Астану и снимаю надолго, жить буду один.",
    "Подскажите, пожалуйста, ещё свободно? Коммунальные входят в цену и какой депозит?",
    "И правильно ли понимаю, что без подселения? Когда можно посмотреть?",
  ].join(" ");
}

/** Оценивает пачку объявлений одним запросом. */
export async function scoreBatch(
  listings: Listing[],
  params: SearchParams,
): Promise<Map<string, AiVerdict>> {
  const ai = genAI();
  const body = listings.map(describe).join("\n\n---\n\n");
  const text = await generateWithRetry(ai, body, params);
  const out = new Map<string, AiVerdict>();
  if (!text) return out;

  let parsed: { items?: Array<AiVerdict & { id: string }> };
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    return out;
  }

  for (const item of parsed.items ?? []) {
    if (!item?.id) continue;
    out.set(item.id, {
      score: Math.max(0, Math.min(100, Math.round(Number(item.score) || 0))),
      verdict: String(item.verdict ?? "").slice(0, 200),
      pros: (item.pros ?? []).slice(0, 3).map(String),
      cons: (item.cons ?? []).slice(0, 3).map(String),
      sharedRisk: (["low", "medium", "high"] as const).includes(item.sharedRisk)
        ? item.sharedRisk
        : "medium",
      scamRisk: (["low", "medium", "high"] as const).includes(item.scamRisk)
        ? item.scamRisk
        : "low",
      message: String(item.message ?? "").slice(0, 700) || defaultMessage(listings, item.id),
    });
  }
  return out;
}
