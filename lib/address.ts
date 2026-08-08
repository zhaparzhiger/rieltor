/**
 * OLX почти никогда не отдаёт точку на карте — только центроид района.
 * Поэтому адрес вытаскиваем из текста объявления и догоняем геокодером.
 */

const CYR = "А-Яа-яЁёӘәҒғҚқҢңӨөҰұҮүҺһІі";
const UPPER = "А-ЯЁӘҒҚҢӨҰҮҺІ";

/** Правобережные районы Астаны (там же, где TAU). Krisha пишет их латиницей. */
const RIGHT_BANK = [
  "сарыарк", "алматин", "алматы", "байконур", "байқоңыр",
  "saryark", "almaty", "almatinsk", "baikonur", "baykonur",
];
const LEFT_BANK = ["есиль", "есіл", "нура", "нұра", "esil", "yesil", "nura"];

export type Bank = "right" | "left" | "unknown";

export function classifyBank(district: string | null | undefined): Bank {
  if (!district) return "unknown";
  const d = district.toLowerCase();
  if (RIGHT_BANK.some((k) => d.includes(k))) return "right";
  if (LEFT_BANK.some((k) => d.includes(k))) return "left";
  return "unknown";
}

/** Слова, которые ловятся регуляркой, но адресом не являются. */
const STOP =
  /квартир|комнат|этаж|сутк|месяц|тенге|тг\b|депозит|м²|кв\.?\s?м|телефон|whatsapp|ватсап|звони|сдам|сдаю|сниму|срочно|хозя|агент|комисс|предоплат|человек|девуш|парн|студент|мебел|ремонт|интернет|автобус|остановк|минут|общежит|секцион|подсел|сосед|душ|туалет|кухн|стиральн|холодильник|порядочн|чистоплотн|привычк|инфраструктур|поликлиник|школ|магазин|базар|рынок|правый|левый/i;

/** Административные районы — как ориентир бесполезны. */
const ADMIN = /^(сарыарк|алматин|есил|есиль|байконур|байқоңыр|нурин|нұра|нура)/i;

export interface GeoCandidate {
  query: string;
  /** Есть номер дома — значит геокодер попадёт в конкретное здание. */
  precise: boolean;
}

const PATTERNS: Array<{ re: RegExp; nameGroup: number; houseGroup?: number }> = [
  // ул. Кенесары 42 / улица Абая, 12 / пр. Республики 5
  {
    re: new RegExp(
      `(?:ул(?:ица|\\.)?|проспект|пр\\.|пр-т|шоссе|бульвар)\\s*[«"']?([${CYR}A-Za-z][${CYR}A-Za-z\\-]{2,25})[»"']?\\s*,?\\s*(\\d{1,3}(?:\\s*[/\\-]\\s*\\d{1,3})?[${CYR}]?)?`,
      "gi",
    ),
    nameGroup: 1,
    houseGroup: 2,
  },
  // ЖК «Асыл Арман» 12
  {
    re: new RegExp(
      `(?:ЖК|жк|ж\\.к\\.)\\s*[«"']?([${CYR}A-Za-z0-9][${CYR}A-Za-z0-9\\s\\-]{2,30}?)[»"']?(?=[,.\\n]|$)`,
      "g",
    ),
    nameGroup: 1,
  },
  // «район Артема», «мкр Коктал-2», «в районе Герцена»
  {
    re: new RegExp(
      `(?:район[еа]?|р-н|мкр\\.?|микрорайон)\\s+[«"']?([${CYR}A-Za-z][${CYR}A-Za-z0-9\\-]{2,25}(?:\\s*-\\s*\\d)?)[»"']?`,
      "gi",
    ),
    nameGroup: 1,
  },
  // «Кордай 39», «Дукенулы 29» — имя собственное + номер дома
  {
    re: new RegExp(
      `\\b([${UPPER}][${CYR}\\-]{3,20})\\s+(\\d{1,3}(?:\\s*[/\\-]\\s*\\d{1,3})?)\\b`,
      "g",
    ),
    nameGroup: 1,
    houseGroup: 2,
  },
  // «Адрес: Герцена», «на Пушкина», «возле Артема»
  {
    re: new RegExp(
      `(?:адрес\\s*:?|возле|около|рядом с|напротив)\\s+[«"']?([${UPPER}][${CYR}\\-]{3,20})`,
      "gi",
    ),
    nameGroup: 1,
  },
];

/** Кандидаты в адрес по убыванию правдоподобности. */
export function extractAddressCandidates(
  ...parts: Array<string | null | undefined>
): GeoCandidate[] {
  const text = parts.filter(Boolean).join("\n");
  const out: GeoCandidate[] = [];

  const push = (name: string, house?: string) => {
    const clean = name.replace(/\s+/g, " ").trim().replace(/[,.\s]+$/, "");
    if (clean.length < 4 || STOP.test(clean) || ADMIN.test(clean)) return;
    const query = `${house ? `${clean} ${house}` : clean}, Астана`;
    if (out.some((c) => c.query === query)) return;
    out.push({ query, precise: Boolean(house) });
  };

  for (const { re, nameGroup, houseGroup } of PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const name = m[nameGroup]?.trim();
      if (!name) continue;
      push(name, houseGroup ? m[houseGroup]?.replace(/\s/g, "") : undefined);
      if (out.length >= 8) break;
    }
  }

  // Сначала адреса с номером дома — они дают точную точку.
  return out.sort((a, b) => Number(b.precise) - Number(a.precise)).slice(0, 5);
}
