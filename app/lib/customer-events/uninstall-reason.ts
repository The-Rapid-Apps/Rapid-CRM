/**
 * Uninstall-reason normalization (spec §7).
 *
 * REWRITTEN 2026-09-14 against real feed data. The first version was written
 * blind — its own header said it was "not verified against Shopify's exact
 * survey token strings, since we haven't seen real feed samples yet" — and it
 * classified the large majority of uninstalls as `unknown_other`. Three
 * things were wrong, all visible the moment the stored `reason` column was
 * actually read:
 *
 *   1. Shopify sends `scheduled_cancellation` as a literal token, not prose.
 *      The old matcher only scanned for keywords, so the single largest
 *      category — the top reason overall — fell through.
 *   2. The store-closure keywords ("closing my store", "store closed") matched
 *      none of Shopify's actual strings, which read "Store is closing or
 *      pausing".
 *   3. The survey is LOCALIZED. English is a minority of the feed: Spanish,
 *      French, German, Portuguese, Italian, Dutch, Swedish, Turkish and
 *      Chinese all appear in volume, and every one of them fell through.
 *
 * The survey is a fixed option set, so this matches the options themselves
 * rather than guessing at keywords. The keyword heuristic survives only as a
 * fallback for genuine free text typed into "Other (please specify)".
 */

export const STORE_CLOSURE_CODES = new Set([
  "store_closing_or_pausing",
  "scheduled_cancellation",
  "deactivated",
]);

/**
 * Shopify's own survey options, as the feed actually spells them.
 *
 * Keyed by `normalize()`'s output, so accents, curly apostrophes, trailing
 * punctuation and casing are already gone — "N’utilise plus l’application" and
 * "n'utilise plus l'application" are one entry, not two.
 */
const SURVEY_OPTIONS: Record<string, string> = {};

function option(code: string, ...phrases: string[]) {
  for (const phrase of phrases) SURVEY_OPTIONS[normalize(phrase)] = code;
}

/* Machine tokens, which arrive instead of a survey answer when the uninstall
   was not a merchant decision at all. `scheduled_cancellation` alone is the
   most common value in the entire feed. */
option("scheduled_cancellation", "scheduled_cancellation");
option("deactivated", "deactivated", "deactivated_closed_account");
option("store_closing_or_pausing", "store_closing_or_pausing");

option(
  "not_using",
  // en
  "Not using app now",
  // es
  "Ya no uso la app",
  "No estoy usando la app ahora",
  "No uso la aplicación actualmente",
  // fr
  "N'utilise plus l'application",
  "N'utilise pas l'application pour le moment",
  "Ne pas utiliser l'application maintenant",
  // de
  "App wird derzeit nicht genutzt",
  "App wird jetzt nicht verwendet",
  // pt
  "Não estou usando o app agora",
  "Não estou usando o app no momento",
  // it
  "Non sto usando l'app al momento",
  "Non sto usando l'app ora",
  "Attualmente non utilizzo l'app",
  // nl
  "Ik gebruik de app momenteel niet",
  "Ik gebruik de app nu niet",
  // sv
  "Använder inte appen just nu",
  "Använder inte appen nu",
  // tr
  "Uygulamayı şu anda kullanmıyorum",
  // zh
  "现在不使用应用",
  "现在不使用此应用",
);

option(
  "testing_multiple_apps",
  "Testing multiple apps",
  "Probando varias apps",
  "Test de plusieurs applis",
  "Testen mehrerer Apps",
  "Testando vários apps",
  "Test di più app",
  "Meerdere apps testen",
  "Birden fazla uygulama test ediliyor",
  "测试多个应用",
);

option(
  "limited_features",
  "Limited or missing features",
  "Not satisfied with app features",
  "Le faltan funciones o las que hay son limitadas",
  "Funciones limitadas o inexistentes",
  "No me satisfacen las funciones de la app",
  "Fonctionnalités limitées ou manquantes",
  "Fonctionnalités de l'appli insatisfaisantes",
  "Eingeschränkte oder fehlende Funktionen",
  "Begrenzte oder fehlende Funktionen",
  "Funzionalità limitate o mancanti",
  "Beperkte of ontbrekende functies",
  "功能受限或不全",
);

option(
  "high_cost",
  "Expensive or unexpected cost",
  "Too expensive",
  "App is not worth the cost",
  "Demasiado cara",
  "Costo caro o inesperado",
  "Costo elevado o inesperado",
  "Trop cher",
  "Coût élevé ou imprévu",
  "Coût élevé ou inattendu",
  "Teuer oder unerwartete Kosten",
  "É caro ou possui cobranças inesperadas",
  "Dure of onverwachte kostprijs",
  "Pahalı veya beklenmedik maliyet",
  "费用较高或存在意外费用",
  "价格过高",
);

option(
  "not_compatible_or_not_working",
  "Not working or compatible with store",
  "Not working properly with store",
  "No funciona correctamente con la tienda",
  "No funciona o no es compatible con la tienda",
  "Ne fonctionne pas ou n'est pas compatible avec la boutique",
  "Ne fonctionne pas correctement avec la boutique",
  "Funktioniert nicht oder nicht mit dem Shop kompatibel",
  "Não funciona ou não é compatível com a loja",
  "Werkt niet of is niet compatibel met de winkel",
  "不适用于商店或与商店不兼容",
);

option(
  "hard_to_setup",
  "Hard to set up or use",
  "Difícil de configurar o usar",
  "Es difícil de configurar o de usar",
  "Difficile à configurer ou à utiliser",
  "Schwierig einzurichten oder zu verwenden",
  "É difícil de configurar ou usar",
  "Moeilijk in te stellen of te gebruiken",
  "难以设置或使用",
);

option(
  "store_closing_or_pausing",
  "Store is closing or pausing",
  "La tienda cerrará o se pausará",
  "Fermeture ou mise en pause de la boutique",
  "Shop wird geschlossen oder pausiert",
  "商店正在关闭或暂停",
);

option(
  "does_not_meet_needs",
  "Does not meet my needs",
  "Ne répond pas à mes besoins",
  "Não atende às minhas necessidades",
  "无法满足我的需求",
);

option(
  "poor_support",
  "Not satisfied with support",
  "Pas satisfait(e) avec l'assistance",
  "对支持服务不满意",
);

option(
  "app_performance_issues",
  "App is not performing well",
  "L'application ne fonctionne pas bien",
  "O app não está funcionando bem",
  "应用表现不佳",
);

option("not_needed_anymore", "Not needed anymore", "Je n'en ai plus besoin");
option("found_alternative", "I found a better app");
option("security_or_privacy_issues", "App security or privacy issues");

/* "Other" is a real answer — the merchant was asked and declined to say. It
   stays `unknown_other`, but matching it explicitly means a merchant who typed
   nothing is not confused with a feed we failed to parse. */
option(
  "unknown_other",
  "Other",
  "Other (please specify)",
  "Otro (especifica)",
  "Autre",
  "Autre (veuillez préciser)",
  "Sonstiges (bitte angeben)",
  "Outro (especifique)",
  "Altro (specifica)",
  "Diğer (lütfen belirtin)",
  "其他",
  "其他（请说明）",
);

/** Last resort for free text typed into "Other (please specify)". English
 * only, and deliberately so: a keyword guess across nine languages would
 * misfire far more often than it helped, and these rows are a small tail. */
const KEYWORD_MAP: Array<{ code: string; keywords: string[] }> = [
  { code: "high_cost", keywords: ["expensive", "too costly", "afford", "price too high"] },
  { code: "limited_features", keywords: ["missing feature", "not enough feature", "lacks"] },
  { code: "poor_support", keywords: ["support", "no response", "unresponsive"] },
  { code: "hard_to_setup", keywords: ["hard to set up", "difficult to configure", "complicated", "confusing"] },
  { code: "security_or_privacy_issues", keywords: ["privacy", "security", "data concern"] },
  {
    code: "not_compatible_or_not_working",
    keywords: ["doesn't work", "not working", "broken", "bug", "incompatible", "conflict"],
  },
  { code: "app_performance_issues", keywords: ["slow", "crash", "performance", "lag"] },
  { code: "found_alternative", keywords: ["switched to", "found another", "alternative", "competitor"] },
  { code: "prefer_native_features", keywords: ["shopify native", "built-in", "native feature"] },
  { code: "testing_multiple_apps", keywords: ["testing", "trying out", "comparing apps"] },
  { code: "unexpected_charges", keywords: ["unexpected charge", "billed without", "surprise charge"] },
  { code: "not_needed_anymore", keywords: ["no longer need", "don't need", "not needed"] },
  { code: "not_using", keywords: ["not using", "unused", "haven't used"] },
  {
    code: "store_closing_or_pausing",
    keywords: ["closing my store", "closing shop", "pausing my store", "store closed"],
  },
];

/**
 * Reduces a survey answer to something matchable.
 *
 * Accents are stripped and curly apostrophes folded because the same option
 * arrives spelled both ways in the feed ("N’utilise" and "N'utilise"), and a
 * table keyed on the raw text would need an entry for each. Chinese options
 * pass through unharmed — they carry no combining marks — apart from their
 * full-width parentheses.
 */
function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[‘’ʼ´`]/g, "'")
    .replace(/[（]/g, "(")
    .replace(/[）]/g, ")")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.\s]+$/g, "")
    .trim();
}

export interface NormalizedUninstallReason {
  reasonCode: string;
  reasonCodes: string[];
  isStoreClosure: boolean;
}

export function normalizeUninstallReason(
  reason: string | null,
  description: string | null,
): NormalizedUninstallReason {
  const raw = `${reason ?? ""}`.trim();
  const text = normalize(`${reason ?? ""} ${description ?? ""}`);

  if (!raw && !normalize(description ?? "")) {
    return { reasonCode: "unknown_other", reasonCodes: ["unknown_other"], isStoreClosure: false };
  }

  /* The survey is multi-select and arrives comma-joined ("Not working or
     compatible with store, Limited or missing features"), so each part is
     looked up on its own and the order the merchant's answers came in is
     preserved — `reasonCode` is the first of them. */
  const codes: string[] = [];
  for (const part of raw.split(",")) {
    const code = SURVEY_OPTIONS[normalize(part)];
    if (code && !codes.includes(code)) codes.push(code);
  }

  /* A whole-string lookup after the split, for the one option that contains a
     comma in some locales and would otherwise be torn in half. */
  if (codes.length === 0) {
    const whole = SURVEY_OPTIONS[normalize(raw)];
    if (whole) codes.push(whole);
  }

  if (codes.length === 0) {
    for (const entry of KEYWORD_MAP) {
      if (entry.keywords.some((keyword) => text.includes(keyword))) {
        codes.push(entry.code);
      }
    }
  }

  const reasonCodes = codes.length > 0 ? codes : ["unknown_other"];
  const isStoreClosure = reasonCodes.some((code) => STORE_CLOSURE_CODES.has(code));
  return { reasonCode: reasonCodes[0]!, reasonCodes, isStoreClosure };
}
