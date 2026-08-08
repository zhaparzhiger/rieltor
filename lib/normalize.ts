import type { ListingFlags } from "./types";

/** Ключевые слова, по которым видно, что это подселение, а не отдельное жильё. */
const SHARED_PATTERNS: Array<[RegExp, string]> = [
  [/подсел|подселен/i, "подселение"],
  [/\bсосед(ка|ки|ку|ей|и|ом)?\b/i, "соседи"],
  [/ищ[уе]м?\s+(деву|парн|соседа|соседку|сожител)/i, "ищут соседа"],
  [/сожител/i, "сожители"],
  [/койко[-\s]?мест|кровать\s+в\s+комнат/i, "койко-место"],
  [/\bна\s+двоих\b|\bна\s+троих\b|\bна\s+четверых\b/i, "на нескольких человек"],
  [/сдам\s+(одно|1)?\s*мест/i, "сдают место"],
  [/\bместо\s+для\s+(деву|парн|студент)/i, "место для человека"],
  [/только\s+для\s+(деву|парн)ш?[а-я]*\s*,?\s*(в|к)\s+/i, "подселение по полу"],
  [/буд[еу]м\s+жить/i, "совместное проживание"],
];

const HOSTEL_PATTERNS: Array<[RegExp, string]> = [
  [/общежит|общага/i, "общежитие"],
  [/секционк|секционн/i, "секционка"],
  [/хостел/i, "хостел"],
];

const DAILY_PATTERNS: Array<[RegExp, string]> = [
  [/посуточн|по\s+суточн/i, "посуточно"],
  [/\bна\s+сутки\b|\bза\s+сутки\b|\bсутки\b/i, "сутки"],
  [/\bпочасов/i, "почасово"],
  [/\bза\s+ночь\b/i, "за ночь"],
];

const SOLO_PATTERNS: Array<[RegExp, string]> = [
  [/без\s+подселен/i, "без подселения"],
  [/без\s+сосед/i, "без соседей"],
  [/один\s+в\s+квартире|жить\s+одному|одному\s+человеку|на\s+одного/i, "на одного"],
  [/отдельн(ая|ую)\s+(квартир|студи)/i, "отдельная квартира"],
];

const STUDENT_PATTERNS: Array<[RegExp, string]> = [
  [/студент/i, "для студентов"],
];

function scan(
  text: string,
  patterns: Array<[RegExp, string]>,
  matched: string[],
): boolean {
  let hit = false;
  for (const [re, label] of patterns) {
    if (re.test(text)) {
      hit = true;
      if (!matched.includes(label)) matched.push(label);
    }
  }
  return hit;
}

export function detectFlags(...parts: Array<string | null | undefined>): ListingFlags {
  const text = parts.filter(Boolean).join("\n");
  const matched: string[] = [];

  const soloFriendly = scan(text, SOLO_PATTERNS, matched);
  const shared = scan(text, SHARED_PATTERNS, matched);
  const hostel = scan(text, HOSTEL_PATTERNS, matched);
  const daily = scan(text, DAILY_PATTERNS, matched);
  const studentFriendly = scan(text, STUDENT_PATTERNS, matched);

  return {
    // Прямое «без подселения» перевешивает случайное упоминание слова «сосед».
    shared: shared && !soloFriendly,
    daily,
    hostel,
    soloFriendly,
    studentFriendly,
    matched,
  };
}

/** «1-комнатная квартира · 13 м² · 2/5 этаж» → 1 / 13 / «2/5». */
export function parseKrishaTitle(title: string): {
  rooms: number | null;
  area: number | null;
  floor: string | null;
} {
  const rooms = title.match(/(\d+)\s*-?\s*комнатн/i);
  const studio = /студи/i.test(title);
  const area = title.match(/([\d.,]+)\s*м²/);
  const floor = title.match(/(\d+\s*\/\s*\d+)\s*этаж/);
  return {
    rooms: rooms ? Number(rooms[1]) : studio ? 1 : null,
    area: area ? Number(area[1].replace(",", ".")) : null,
    floor: floor ? floor[1].replace(/\s/g, "") : null,
  };
}

/** «80 000 ₸» / «80&nbsp;000» → 80000. */
export function parsePrice(raw: string): number | null {
  const digits = raw.replace(/[^\d]/g, "");
  if (!digits) return null;
  const n = Number(digits);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function cleanText(raw: string | null | undefined, limit = 1400): string {
  if (!raw) return "";
  return raw
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, limit);
}
