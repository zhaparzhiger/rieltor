import type { NextConfig } from "next";

const config: NextConfig = {
  // Для контейнера собираем self-contained сервер: образ выходит в разы меньше.
  output: "standalone",
  images: { unoptimized: true },
  // cheerio и клиент Vertex тянут node-only зависимости — не бандлим их.
  serverExternalPackages: ["cheerio", "@google/genai"],
};

export default config;
