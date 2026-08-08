import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import { env } from "./env";
import { DEFAULT_PARAMS, emptyStats, type Listing, type RunState } from "./types";

function stateFile(): string {
  // resolve, а не join: DATA_DIR на хостинге задают абсолютным путём.
  return path.resolve(process.cwd(), env.dataDir, "state.json");
}

export function emptyState(): RunState {
  return {
    params: DEFAULT_PARAMS,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    status: "idle",
    error: null,
    stats: emptyStats(),
    listings: [],
  };
}

/** Файл мог остаться от прежней версии — доливаем поля, появившиеся позже. */
function migrate(listing: Listing): Listing {
  return {
    ...listing,
    phones: Array.isArray(listing.phones) ? listing.phones : [],
    phoneHint: listing.phoneHint ?? null,
    message: listing.message ?? "",
  };
}

export async function readState(): Promise<RunState> {
  try {
    const raw = await fs.readFile(stateFile(), "utf8");
    const state = JSON.parse(raw) as RunState;
    state.listings = (state.listings ?? []).map(migrate);
    return state;
  } catch {
    return emptyState();
  }
}

/**
 * На бесплатных хостингах диск бывает эфемерным или недоступным на запись —
 * прогон от этого падать не должен, результат всё равно уже в памяти задачи.
 */
export async function writeState(state: RunState): Promise<void> {
  const file = stateFile();
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(state, null, 1), "utf8");
  } catch (e) {
    console.warn("Не удалось сохранить результат на диск:", (e as Error).message);
  }
}

/** Точечно обновляет одно объявление (например, проставляет вердикт ИИ). */
export async function patchListings(
  updater: (listings: Listing[]) => Listing[],
): Promise<RunState> {
  const state = await readState();
  state.listings = updater(state.listings);
  await writeState(state);
  return state;
}
