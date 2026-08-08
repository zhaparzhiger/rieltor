"use client";

import { useState } from "react";
import { formatPhone, normalizePhone, waLink } from "@/lib/phone";
import type { Listing } from "@/lib/types";

const SOURCE_BADGE: Record<string, { label: string; className: string }> = {
  "krisha-kvartiry": { label: "Krisha · квартира", className: "bg-[#1d3a2a] text-[#7ee2ab]" },
  "krisha-komnaty": { label: "Krisha · комната", className: "bg-[#1d3a2a] text-[#7ee2ab]" },
  "olx-kvartiry": { label: "OLX · квартира", className: "bg-[#3a2a1d] text-[#f5c07e]" },
  "olx-komnaty": { label: "OLX · комната", className: "bg-[#3a2a1d] text-[#f5c07e]" },
};

function scoreColor(score: number): string {
  if (score >= 85) return "text-good border-good/40 bg-good/10";
  if (score >= 60) return "text-[#9cd0ff] border-accent/40 bg-accent/10";
  if (score >= 30) return "text-warn border-warn/40 bg-warn/10";
  return "text-bad border-bad/40 bg-bad/10";
}

function money(n: number | null): string {
  return n === null ? "цена не указана" : `${n.toLocaleString("ru-RU")} ₸`;
}

export default function ListingCard({ listing }: { listing: Listing }) {
  const [message, setMessage] = useState(listing.message ?? "");
  const [manualPhone, setManualPhone] = useState("");
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);

  const [fetched, setFetched] = useState<string[]>([]);
  const [loadingPhone, setLoadingPhone] = useState(false);
  const [hint, setHint] = useState(listing.phoneHint);

  const badge = SOURCE_BADGE[listing.source] ?? { label: listing.source, className: "bg-ink-3" };
  const ai = listing.ai;
  const manual = normalizePhone(manualPhone);
  const known = listing.phones?.length ? listing.phones : fetched;
  const phones = known.length ? known : manual ? [manual] : [];

  async function revealPhone() {
    setLoadingPhone(true);
    try {
      const res = await fetch("/api/phone", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: listing.id }),
      });
      const data = (await res.json()) as { phones?: string[]; hint?: string };
      setFetched(data.phones ?? []);
      if (!data.phones?.length) setHint(data.hint ?? "Номер получить не удалось");
    } catch {
      setHint("Номер получить не удалось");
    } finally {
      setLoadingPhone(false);
    }
  }

  async function copyMessage() {
    try {
      await navigator.clipboard.writeText(message);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* буфер обмена может быть недоступен — текст всё равно виден в поле */
    }
  }

  const mapUrl =
    listing.lat !== null && listing.lon !== null
      ? `https://2gis.kz/astana/geo/${listing.lon},${listing.lat}`
      : null;

  return (
    <article className="flex flex-col gap-3 rounded-2xl border border-line bg-ink-2 p-4 transition hover:border-accent/50">
      <div className="flex gap-4">
        {listing.photo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={listing.photo}
            alt=""
            loading="lazy"
            className="h-28 w-40 shrink-0 rounded-xl object-cover"
          />
        ) : (
          <div className="flex h-28 w-40 shrink-0 items-center justify-center rounded-xl border border-dashed border-line text-xs text-mute">
            нет фото
          </div>
        )}

        <div className="min-w-0 flex-1">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <span className={`rounded-md px-2 py-0.5 text-[11px] font-medium ${badge.className}`}>
              {badge.label}
            </span>
            {listing.sellerType === "owner" && (
              <span className="rounded-md bg-good/15 px-2 py-0.5 text-[11px] text-good">хозяин</span>
            )}
            {listing.sellerType === "agent" && (
              <span className="rounded-md bg-warn/15 px-2 py-0.5 text-[11px] text-warn">агент</span>
            )}
            {listing.flags.soloFriendly && (
              <span className="rounded-md bg-good/15 px-2 py-0.5 text-[11px] text-good">
                без подселения
              </span>
            )}
            {listing.flags.shared && (
              <span className="rounded-md bg-bad/15 px-2 py-0.5 text-[11px] text-bad">
                похоже на подселение
              </span>
            )}
            {listing.flags.hostel && (
              <span className="rounded-md bg-warn/15 px-2 py-0.5 text-[11px] text-warn">
                общежитие / секционка
              </span>
            )}
          </div>

          <a
            href={listing.url}
            target="_blank"
            rel="noreferrer"
            className="line-clamp-2 font-medium text-[#e8eeff] hover:text-accent"
          >
            {listing.title}
          </a>

          <div className="mt-1 text-sm text-mute">{listing.address || "адрес не указан"}</div>

          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
            <span className="text-base font-semibold text-[#e8eeff]">{money(listing.price)}</span>
            {listing.distanceKm !== null ? (
              <span className={listing.geoSource === "approx" ? "text-warn" : "text-[#9cd0ff]"}>
                {listing.geoSource === "approx" ? "≈ " : ""}
                {listing.distanceKm.toFixed(2)} км до университета
                {listing.geoSource === "geocoded" && (
                  <span className="text-mute"> · адрес найден по тексту</span>
                )}
                {listing.geoSource === "approx" && (
                  <span className="text-mute"> · только улица, без номера дома</span>
                )}
              </span>
            ) : (
              <span className="text-warn">адрес неточный · {listing.district ?? "район не указан"}</span>
            )}
            {listing.rooms !== null && <span className="text-mute">{listing.rooms} комн.</span>}
            {listing.area !== null && <span className="text-mute">{listing.area} м²</span>}
            {listing.floor && <span className="text-mute">этаж {listing.floor}</span>}
          </div>
        </div>

        {ai && (
          <div
            className={`flex h-16 w-16 shrink-0 flex-col items-center justify-center rounded-xl border ${scoreColor(ai.score)}`}
          >
            <span className="text-xl font-bold leading-none">{ai.score}</span>
            <span className="text-[10px] opacity-70">из 100</span>
          </div>
        )}
      </div>

      {ai && (
        <div className="rounded-xl border border-line/60 bg-ink-3/50 p-3 text-sm">
          <p className="text-[#dbe5ff]">{ai.verdict}</p>
          {(ai.pros.length > 0 || ai.cons.length > 0) && (
            <div className="mt-2 grid gap-1 sm:grid-cols-2">
              <ul className="space-y-0.5">
                {ai.pros.map((p, i) => (
                  <li key={i} className="text-good">
                    + {p}
                  </li>
                ))}
              </ul>
              <ul className="space-y-0.5">
                {ai.cons.map((c, i) => (
                  <li key={i} className="text-[#ffb3b6]">
                    − {c}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="mt-2 flex gap-3 text-[11px] text-mute">
            <span>риск подселения: {ai.sharedRisk}</span>
            <span>риск обмана: {ai.scamRisk}</span>
          </div>
        </div>
      )}

      {listing.description && (
        <details className="text-sm text-mute">
          <summary className="cursor-pointer select-none hover:text-[#dbe5ff]">Описание</summary>
          <p className="mt-2 whitespace-pre-wrap text-[#c6d2f0]">{listing.description}</p>
        </details>
      )}

      {/* ── Связаться ─────────────────────────────────────────────────── */}
      <div className="rounded-xl border border-line/60 bg-ink-3/40 p-3">
        <div className="flex flex-wrap items-center gap-2">
          {phones.length > 0 ? (
            phones.map((phone) => (
              <a
                key={phone}
                href={waLink(phone, message)}
                target="_blank"
                rel="noreferrer"
                className="rounded-lg bg-[#25d366] px-3 py-1.5 text-sm font-medium text-[#06301a] hover:bg-[#1fb857]"
              >
                WhatsApp · {formatPhone(phone)}
              </a>
            ))
          ) : (
            <>
              <button
                type="button"
                onClick={revealPhone}
                disabled={loadingPhone}
                className="rounded-lg bg-accent/15 px-3 py-1.5 text-sm text-accent hover:bg-accent/25 disabled:opacity-50"
              >
                {loadingPhone ? "Запрашиваю…" : "Показать номер"}
              </button>
              <input
                value={manualPhone}
                onChange={(e) => setManualPhone(e.target.value)}
                placeholder="или вставьте номер"
                inputMode="tel"
                className="w-44 rounded-lg border border-line bg-ink px-3 py-1.5 text-sm"
              />
              <span className="text-xs text-mute">
                {manualPhone && !manual
                  ? "не похоже на казахстанский номер"
                  : (hint ?? "")}
              </span>
            </>
          )}

          {phones.length > 0 && (
            <a
              href={`tel:+${phones[0]}`}
              className="rounded-lg bg-ink-3 px-3 py-1.5 text-sm text-mute hover:text-[#e8eeff]"
            >
              Позвонить
            </a>
          )}

          <button
            type="button"
            onClick={copyMessage}
            className="rounded-lg bg-ink-3 px-3 py-1.5 text-sm text-mute hover:text-[#e8eeff]"
          >
            {copied ? "Скопировано" : "Скопировать текст"}
          </button>
          <button
            type="button"
            onClick={() => setEditing((v) => !v)}
            className="rounded-lg px-2 py-1.5 text-sm text-mute hover:text-[#e8eeff]"
          >
            {editing ? "Свернуть" : "Изменить текст"}
          </button>
        </div>

        {editing ? (
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            rows={5}
            className="mt-2 w-full resize-y rounded-lg border border-line bg-ink p-2 text-sm text-[#c6d2f0]"
          />
        ) : (
          <p className="mt-2 line-clamp-2 text-xs text-mute">{message}</p>
        )}
      </div>

      <div className="flex flex-wrap gap-3 text-sm">
        <a
          href={listing.url}
          target="_blank"
          rel="noreferrer"
          className="rounded-lg bg-accent/15 px-3 py-1.5 text-accent hover:bg-accent/25"
        >
          Открыть объявление
        </a>
        {mapUrl && (
          <a
            href={mapUrl}
            target="_blank"
            rel="noreferrer"
            className="rounded-lg bg-ink-3 px-3 py-1.5 text-mute hover:text-[#e8eeff]"
          >
            Показать на карте
          </a>
        )}
        {listing.postedAt && (
          <span className="self-center text-xs text-mute">
            обновлено: {listing.postedAt.length > 12 ? listing.postedAt.slice(0, 10) : listing.postedAt}
          </span>
        )}
      </div>
    </article>
  );
}
