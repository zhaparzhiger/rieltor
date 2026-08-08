# Сборка standalone-приложения Next.js.
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

FROM node:22-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# Кэш страниц, геокэш и последний результат. На эфемерном диске просто теряются.
ENV DATA_DIR=/app/data

RUN useradd --system --uid 1001 --create-home nextjs

# Каталога public в проекте нет — статику отдаёт только .next/static.
COPY --from=builder --chown=nextjs:nextjs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nextjs /app/.next/static ./.next/static

RUN mkdir -p /app/data && chown -R nextjs:nextjs /app/data
USER nextjs

EXPOSE 3007
ENV PORT=3007
ENV HOSTNAME=0.0.0.0

CMD ["node", "server.js"]
