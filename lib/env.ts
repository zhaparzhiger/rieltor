import "server-only";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * На хостинге файла с ключом нет — сервисный аккаунт приезжает целиком в
 * переменной GOOGLE_SERVICE_ACCOUNT_JSON. Библиотека Google умеет читать только
 * файл, поэтому кладём содержимое во временный и показываем на него путь.
 */
function materializeServiceAccount(): void {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw || process.env.GOOGLE_APPLICATION_CREDENTIALS) return;

  try {
    const file = path.join(os.tmpdir(), "rieltor-gcp-key.json");
    fs.writeFileSync(file, raw, { encoding: "utf8", mode: 0o600 });
    process.env.GOOGLE_APPLICATION_CREDENTIALS = file;
  } catch (e) {
    console.warn("Не удалось сохранить ключ сервисного аккаунта:", (e as Error).message);
  }
}

materializeServiceAccount();

function flag(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return raw === "1" || raw.toLowerCase() === "true";
}

export const env = {
  geminiApiKey: process.env.GEMINI_API_KEY ?? "",
  useVertex: flag("GEMINI_USE_VERTEX", false),
  googleCloudProject: process.env.GOOGLE_CLOUD_PROJECT ?? "",
  googleCloudLocation: process.env.GOOGLE_CLOUD_LOCATION ?? "us-central1",
  geminiModel: process.env.GEMINI_MODEL ?? "gemini-2.5-flash",

  dataDir: process.env.DATA_DIR ?? "data",

  /**
   * Krisha показывает телефон только авторизованным. Если вставить сюда свою
   * строку Cookie из браузера, парсер сможет доставать номера вашим же аккаунтом.
   * Пусто — приложение покажет только превью вида «+7 701 …».
   */
  krishaCookie: process.env.KRISHA_COOKIE ?? "",
};

export function hasGemini(): boolean {
  return env.useVertex ? env.googleCloudProject.length > 0 : env.geminiApiKey.length > 0;
}
