import { NextRequest } from "next/server";
import { fetchKrishaPhones } from "@/lib/sources/krisha";
import { fetchOlxPhone } from "@/lib/sources/olx";
import { patchListings, readState } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Номер по требованию: один запрос в момент, когда пользователь реально хочет
 * написать. Массово их спрашивать нельзя — оба сайта считают это злоупотреблением.
 */
export async function POST(req: NextRequest) {
  const { id } = (await req.json().catch(() => ({}))) as { id?: string };
  if (!id) return Response.json({ error: "не передан id объявления" }, { status: 400 });

  const state = await readState();
  const listing = state.listings.find((l) => l.id === id);
  if (!listing) return Response.json({ error: "объявление не найдено" }, { status: 404 });
  if (listing.phones?.length) return Response.json({ phones: listing.phones });

  try {
    const phones = listing.source.startsWith("olx")
      ? await fetchOlxPhone(listing.externalId, listing.url)
      : await fetchKrishaPhones(listing.externalId);

    if (!phones.length) {
      return Response.json({
        phones: [],
        hint: listing.source.startsWith("olx")
          ? "OLX не показал номер — откройте объявление"
          : "Krisha отдаёт номер только вошедшим в аккаунт (см. KRISHA_COOKIE в .env.local)",
      });
    }

    await patchListings((all) =>
      all.map((l) => (l.id === id ? { ...l, phones, phoneHint: null } : l)),
    );
    return Response.json({ phones });
  } catch (e) {
    const blocked = /400|подозрительн/i.test((e as Error).message);
    return Response.json({
      phones: [],
      hint: blocked
        ? "Сайт притормозил выдачу номеров, попробуйте через пару минут"
        : "Не удалось получить номер",
    });
  }
}
