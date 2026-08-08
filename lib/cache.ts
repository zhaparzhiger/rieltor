import "server-only";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { env } from "./env";

/**
 * Дисковый кэш ответов. Нужен не столько для скорости, сколько чтобы
 * повторный прогон не долбил krisha.kz теми же страницами: за резкий
 * всплеск запросов сайт блокирует IP на уровне TCP.
 */

function fileFor(namespace: string, key: string): string {
  // URL-ы страниц выдачи различаются только хвостом (`&page=2`), поэтому имя
  // файла строим из хэша: обрезанный по длине ключ склеивал соседние страницы.
  const digest = createHash("sha1").update(key).digest("hex").slice(0, 16);
  const readable = key.replace(/[^a-z0-9_-]/gi, "_").slice(0, 60);
  return path.join(process.cwd(), env.dataDir, "cache", namespace, `${readable}-${digest}.json`);
}

export async function cacheGet<T>(namespace: string, key: string, ttlMs: number): Promise<T | null> {
  try {
    const raw = await fs.readFile(fileFor(namespace, key), "utf8");
    const parsed = JSON.parse(raw) as { at: number; value: T };
    if (Date.now() - parsed.at > ttlMs) return null;
    return parsed.value;
  } catch {
    return null;
  }
}

export async function cacheSet<T>(namespace: string, key: string, value: T): Promise<void> {
  const file = fileFor(namespace, key);
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ at: Date.now(), value }), "utf8");
  } catch {
    /* кэш необязателен */
  }
}
