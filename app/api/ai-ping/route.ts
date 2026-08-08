import { GoogleGenAI } from "@google/genai";
import { env, hasGemini } from "@/lib/env";
import { scoreBatch } from "@/lib/ai";
import { DEFAULT_PARAMS, type Listing } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function fakeListing(): Listing {
  return {
    id: "test:1",
    source: "krisha-kvartiry",
    externalId: "1",
    url: "https://krisha.kz/a/show/1",
    title: "1-комнатная квартира · 30 м² · 2/5 этаж",
    price: 75_000,
    description: "Сдаётся однокомнатная квартира рядом с университетом, без подселения.",
    address: "Айманова 11",
    district: "Алматы р-н",
    rooms: 1,
    area: 30,
    floor: "2/5",
    lat: 51.18,
    lon: 71.43,
    geoSource: "listing",
    distanceKm: 0.4,
    photo: null,
    photosCount: 3,
    sellerType: "owner",
    phones: [],
    phoneHint: null,
    postedAt: null,
    message: "",
    flags: { shared: false, daily: false, hostel: false, soloFriendly: true, studentFriendly: false, matched: [] },
    ai: null,
  };
}

/** Диагностика: жив ли доступ к Gemini и не упёрлись ли в квоту проекта. */
export async function GET(req: Request) {
  const started = Date.now();
  if (!hasGemini()) {
    return Response.json({ ok: false, error: "Gemini не настроен в .env.local" });
  }

  // ?full=1 — прогоняем тот же вызов, что и скоринг объявлений.
  if (new URL(req.url).searchParams.get("full") === "1") {
    try {
      const out = await scoreBatch([fakeListing()], DEFAULT_PARAMS);
      return Response.json({ ok: true, ms: Date.now() - started, verdicts: [...out.values()] });
    } catch (e) {
      return Response.json({ ok: false, ms: Date.now() - started, error: (e as Error).message.slice(0, 300) });
    }
  }

  try {
    const ai = env.useVertex
      ? new GoogleGenAI({
          vertexai: true,
          project: env.googleCloudProject,
          location: env.googleCloudLocation,
          httpOptions: { timeout: 60_000 },
        })
      : new GoogleGenAI({ apiKey: env.geminiApiKey, httpOptions: { timeout: 60_000 } });

    const res = await ai.models.generateContent({
      model: env.geminiModel,
      contents: "Ответь одним словом: работает",
      config: { temperature: 0 },
    });
    return Response.json({ ok: true, ms: Date.now() - started, model: env.geminiModel, text: res.text });
  } catch (e) {
    const message = (e as Error).message ?? "";
    return Response.json({
      ok: false,
      ms: Date.now() - started,
      quota: /429|RESOURCE_EXHAUSTED|quota/i.test(message),
      error: message.slice(0, 300),
    });
  }
}
