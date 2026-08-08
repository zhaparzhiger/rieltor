import "server-only";

/**
 * Krisha и OLX отдают 403 на «голый» запрос: за CDN стоит проверка заголовков.
 * Полный набор браузерных заголовков + повторы с паузой решают вопрос без headless-браузера.
 */

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent": UA,
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "ru-RU,ru;q=0.9,kk;q=0.8,en;q=0.7",
  "Cache-Control": "no-cache",
  Pragma: "no-cache",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Upgrade-Insecure-Requests": "1",
};

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface FetchOptions {
  headers?: Record<string, string>;
  retries?: number;
  timeoutMs?: number;
}

export async function fetchText(url: string, opts: FetchOptions = {}): Promise<string> {
  const { headers = {}, retries = 2, timeoutMs = 25_000 } = opts;
  let lastError: unknown = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: { ...BROWSER_HEADERS, ...headers },
        signal: ac.signal,
        redirect: "follow",
      });
      if (res.status === 404) throw new Error(`404 ${url}`);
      if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
      return await res.text();
    } catch (e) {
      lastError = e;
      if (attempt < retries) await sleep(700 * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
