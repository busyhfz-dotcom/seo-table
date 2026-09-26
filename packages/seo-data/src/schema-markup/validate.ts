/**
 * Structured data validation against Google Search Central's documented
 * required and recommended properties per rich-result type (as documented
 * through 2025; Google changes these, so each rule names the feature it serves).
 *
 * Levels: "error" — Google's documented requirement is missing or malformed,
 * so the rich result cannot appear; "warning" — a recommended property is
 * missing, or the markup is valid but the feature is limited/retired; "info" —
 * context worth knowing. Paths use dots; "a|b" means either satisfies; a path
 * through an array checks every element.
 *
 * Feature notes that shape the rules:
 *   - FAQPage: since August 2023 FAQ rich results are shown only for well-known,
 *     authoritative government and health sites.
 *   - HowTo: rich results were retired in September 2023.
 *   - WebSite SearchAction: the sitelinks search box was retired in November
 *     2024; WebSite name/url still feed the site name shown in results.
 *   - Person: no rich result of its own; it serves as author / profile data.
 *   - Product: a product snippet needs name plus one of offers, review or
 *     aggregateRating. Ratings and reviews must be real and visible on the page
 *     (Google's review snippet guidelines); the generator never invents them.
 */
export type IssueLevel = "error" | "warning" | "info";
export type SchemaIssue = { level: IssueLevel; code: string; path: string; message: { fa: string; en: string } };

type Node = Record<string, unknown>;

const LOCAL_BUSINESS_TYPES = new Set([
  "LocalBusiness", "Store", "Restaurant", "CafeOrCoffeeShop", "Bakery", "BarOrPub", "FastFoodRestaurant", "FoodEstablishment",
  "AutoRepair", "AutomotiveBusiness", "BeautySalon", "HairSalon", "DaySpa", "Dentist", "MedicalClinic", "Physician", "Pharmacy",
  "Hotel", "LodgingBusiness", "RealEstateAgent", "TravelAgency", "LegalService", "Attorney", "AccountingService", "FinancialService",
  "HomeAndConstructionBusiness", "Electrician", "Plumber", "GeneralContractor", "SportsActivityLocation", "ExerciseGym",
  "EducationalOrganization", "ClothingStore", "ElectronicsStore", "FurnitureStore", "GroceryStore", "HardwareStore", "BookStore",
  "ComputerStore", "MobilePhoneStore", "JewelryStore", "ShoeStore", "ToyStore", "Optician", "VeterinaryCare", "ProfessionalService",
]);
const ARTICLE_TYPES = new Set(["Article", "NewsArticle", "BlogPosting", "Report", "TechArticle", "ScholarlyArticle"]);

export const SUPPORTED_TYPES = [
  "Organization",
  "LocalBusiness",
  "WebSite",
  "BreadcrumbList",
  "Article",
  "BlogPosting",
  "NewsArticle",
  "Product",
  "FAQPage",
  "HowTo",
  "Person",
  "Event",
] as const;
export type SchemaType = (typeof SUPPORTED_TYPES)[number];

type Rules = {
  required: string[];
  recommended: string[];
  check?: (node: Node, out: SchemaIssue[]) => void;
};

const t = (fa: string, en: string) => ({ fa, en });

function missing(level: IssueLevel, path: string): SchemaIssue {
  return level === "error"
    ? { level, code: "missing_required", path, message: t(`ویژگی الزامی «${path}» وجود ندارد.`, `Required property "${path}" is missing.`) }
    : { level, code: "missing_recommended", path, message: t(`ویژگی پیشنهادی «${path}» وجود ندارد.`, `Recommended property "${path}" is missing.`) };
}

const isEmpty = (v: unknown) =>
  v === undefined || v === null || (typeof v === "string" && v.trim() === "") || (Array.isArray(v) && v.length === 0);

/** Values at a dotted path; arrays fan out. An empty result means "absent somewhere along the path". */
function valuesAt(node: unknown, path: string): { present: boolean; values: unknown[] } {
  const parts = path.split(".");
  let current: unknown[] = [node];
  for (const part of parts) {
    const next: unknown[] = [];
    for (const c of current) {
      const items = Array.isArray(c) ? c : [c];
      for (const item of items) {
        if (!item || typeof item !== "object") return { present: false, values: [] };
        const v = (item as Node)[part];
        if (isEmpty(v)) return { present: false, values: [] };
        next.push(v);
      }
    }
    current = next;
  }
  return { present: true, values: current.flatMap((v) => (Array.isArray(v) ? v : [v])) };
}

function has(node: unknown, spec: string): boolean {
  return spec.split("|").some((p) => valuesAt(node, p).present);
}

function typesOf(node: Node): string[] {
  const t = node["@type"];
  return Array.isArray(t) ? t.filter((x): x is string => typeof x === "string") : typeof t === "string" ? [t] : [];
}

const URL_RE = /^https?:\/\/[^\s/$.?#].[^\s]*$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

function checkUrls(node: Node, paths: string[], out: SchemaIssue[]) {
  for (const p of paths) {
    for (const v of valuesAt(node, p).values) {
      const s = typeof v === "string" ? v : v && typeof v === "object" ? ((v as Node).url ?? (v as Node)["@id"]) : null;
      if (typeof s === "string" && !URL_RE.test(s)) {
        out.push({ level: "error", code: "invalid_url", path: p, message: t(`«${p}» باید نشانی کامل (با https://) باشد.`, `"${p}" must be an absolute URL (with https://).`) });
      }
    }
  }
}

function checkDates(node: Node, paths: string[], out: SchemaIssue[], wantTimezone = false) {
  for (const p of paths) {
    for (const v of valuesAt(node, p).values) {
      if (typeof v !== "string" || !DATE_RE.test(v.trim()) || Number.isNaN(Date.parse(v))) {
        out.push({ level: "error", code: "invalid_date", path: p, message: t(`«${p}» باید تاریخ ISO 8601 باشد (مثلاً 2025-03-01T09:00:00+03:30).`, `"${p}" must be an ISO 8601 date (e.g. 2025-03-01T09:00:00+03:30).`) });
      } else if (wantTimezone && v.includes("T") && !/(Z|[+-]\d{2}:?\d{2})$/.test(v.trim())) {
        out.push({ level: "warning", code: "date_without_timezone", path: p, message: t(`برای «${p}» منطقهٔ زمانی (مثلاً +03:30) را هم بنویسید.`, `Give "${p}" a time zone offset (e.g. +03:30).`) });
      }
    }
  }
}

function checkNumber(node: Node, path: string, out: SchemaIssue[]) {
  for (const v of valuesAt(node, path).values) {
    const n = typeof v === "number" ? v : typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : NaN;
    if (!Number.isFinite(n)) {
      out.push({ level: "error", code: "invalid_number", path, message: t(`«${path}» باید عدد باشد (بدون نماد پول یا جداکننده).`, `"${path}" must be a number (no currency symbol or separators).`) });
    }
  }
}

const RULES: Record<string, Rules> = {
  Organization: {
    required: [],
    recommended: ["name", "url", "logo", "sameAs", "description", "telephone|email|contactPoint", "address"],
    check: (n, out) => checkUrls(n, ["url", "logo", "sameAs"], out),
  },
  LocalBusiness: {
    required: ["name", "address"],
    recommended: ["address.streetAddress", "address.addressLocality", "address.postalCode", "address.addressCountry", "telephone", "url", "geo", "openingHoursSpecification", "priceRange", "image"],
    check: (n, out) => {
      checkUrls(n, ["url", "image", "menu"], out);
      for (const axis of ["latitude", "longitude"]) {
        for (const v of valuesAt(n, `geo.${axis}`).values) {
          const decimals = String(v).split(".")[1]?.length ?? 0;
          if (!Number.isFinite(Number(v))) out.push({ level: "error", code: "invalid_number", path: `geo.${axis}`, message: t(`«geo.${axis}» باید عدد باشد.`, `"geo.${axis}" must be a number.`) });
          else if (decimals < 5) out.push({ level: "warning", code: "geo_precision", path: `geo.${axis}`, message: t(`گوگل دست‌کم ۵ رقم اعشار برای «geo.${axis}» توصیه می‌کند.`, `Google recommends at least 5 decimal places for "geo.${axis}".`) });
        }
      }
    },
  },
  WebSite: {
    required: ["name", "url"],
    recommended: ["alternateName"],
    check: (n, out) => {
      checkUrls(n, ["url"], out);
      if (valuesAt(n, "potentialAction").present) {
        out.push({ level: "info", code: "sitelinks_searchbox_retired", path: "potentialAction", message: t("گوگل کادر جست‌وجوی سایت‌لینک را از نوامبر ۲۰۲۴ نمایش نمی‌دهد؛ این بخش بی‌ضرر اما بی‌اثر است.", "Google retired the sitelinks search box in November 2024; this part is harmless but has no effect.") });
      }
    },
  },
  BreadcrumbList: {
    required: ["itemListElement", "itemListElement.position", "itemListElement.name"],
    recommended: [],
    check: (n, out) => {
      const items = Array.isArray(n.itemListElement) ? (n.itemListElement as Node[]) : [];
      items.forEach((item, i) => {
        if (i < items.length - 1 && isEmpty(item.item)) out.push({ level: "error", code: "missing_required", path: `itemListElement[${i}].item`, message: t(`آدرس (item) مورد ${i + 1} مسیر راهنما وجود ندارد؛ فقط مورد آخر می‌تواند بدون آدرس باشد.`, `Breadcrumb item ${i + 1} has no "item" URL; only the last item may omit it.`) });
        if (Number(item.position) !== i + 1) out.push({ level: "warning", code: "position_order", path: `itemListElement[${i}].position`, message: t("شمارهٔ position باید از ۱ و به ترتیب باشد.", "position should count from 1 in order.") });
      });
      checkUrls(n, ["itemListElement.item"], out);
    },
  },
  Article: {
    required: [],
    recommended: ["headline", "image", "datePublished", "dateModified", "author", "author.name"],
    check: (n, out) => {
      const headline = typeof n.headline === "string" ? n.headline : "";
      if ([...headline].length > 110) out.push({ level: "warning", code: "headline_long", path: "headline", message: t("عنوان (headline) بیش از ۱۱۰ نویسه است؛ کوتاه‌تر بنویسید.", "The headline is over 110 characters; keep it concise.") });
      checkDates(n, ["datePublished", "dateModified"], out, true);
      checkUrls(n, ["image", "author.url"], out);
      if (valuesAt(n, "author").present && !has(n, "author.url|author.sameAs")) {
        out.push({ level: "warning", code: "missing_recommended", path: "author.url", message: t("برای نویسنده نشانی صفحهٔ معرفی (author.url) بدهید.", "Give the author a profile page URL (author.url).") });
      }
    },
  },
  Product: {
    required: ["name", "offers|review|aggregateRating"],
    recommended: ["image", "description", "sku|gtin|gtin8|gtin12|gtin13|gtin14|mpn", "brand"],
    check: (n, out) => {
      checkUrls(n, ["image", "offers.url"], out);
      if (valuesAt(n, "offers").present) {
        if (!has(n, "offers.price|offers.priceSpecification.price|offers.lowPrice")) out.push(missing("error", "offers.price"));
        else checkNumber(n, "offers.price", out);
        if (!has(n, "offers.priceCurrency|offers.priceSpecification.priceCurrency")) out.push(missing("warning", "offers.priceCurrency"));
        if (!has(n, "offers.availability")) out.push(missing("warning", "offers.availability"));
      }
      if (valuesAt(n, "aggregateRating").present) {
        if (!has(n, "aggregateRating.ratingValue")) out.push(missing("error", "aggregateRating.ratingValue"));
        if (!has(n, "aggregateRating.ratingCount|aggregateRating.reviewCount")) out.push(missing("error", "aggregateRating.ratingCount"));
        out.push({ level: "info", code: "ratings_must_be_real", path: "aggregateRating", message: t("امتیاز و نظرها باید واقعی و روی همین صفحه قابل دیدن باشند؛ امتیاز ساختگی به جریمهٔ دستی گوگل می‌انجامد.", "Ratings and reviews must be real and visible on this page; made-up ratings lead to a Google manual action.") });
      }
    },
  },
  FAQPage: {
    required: ["mainEntity", "mainEntity.name", "mainEntity.acceptedAnswer", "mainEntity.acceptedAnswer.text"],
    recommended: [],
    check: (_n, out) => {
      out.push({ level: "warning", code: "faq_limited", path: "@type", message: t("از اوت ۲۰۲۳ گوگل نتیجهٔ غنی FAQ را فقط برای سایت‌های معتبر دولتی و سلامت نشان می‌دهد؛ این نشانه‌گذاری معمولاً ستارهٔ ظاهری نمی‌آورد.", "Since August 2023 Google shows FAQ rich results only for well-known government and health sites; for most sites this markup changes nothing visible.") });
    },
  },
  HowTo: {
    required: ["name", "step"],
    recommended: ["image", "totalTime", "supply", "tool"],
    check: (_n, out) => {
      out.push({ level: "warning", code: "howto_deprecated", path: "@type", message: t("گوگل نتیجهٔ غنی HowTo را از سپتامبر ۲۰۲۳ کنار گذاشته است؛ این نشانه‌گذاری دیگر در نتایج دیده نمی‌شود.", "Google retired HowTo rich results in September 2023; this markup no longer shows in results.") });
    },
  },
  Person: {
    required: ["name"],
    recommended: ["url", "image", "sameAs", "jobTitle"],
    check: (n, out) => {
      checkUrls(n, ["url", "image", "sameAs"], out);
      out.push({ level: "info", code: "person_no_rich_result", path: "@type", message: t("Person به‌تنهایی نتیجهٔ غنی ندارد؛ برای نویسندهٔ مقاله و صفحهٔ پروفایل به کار می‌رود.", "Person has no rich result of its own; it serves as article author and profile data.") });
    },
  },
  Event: {
    required: ["name", "startDate", "location"],
    recommended: ["description", "endDate", "eventStatus", "eventAttendanceMode", "image", "offers", "organizer", "performer"],
    check: (n, out) => {
      checkDates(n, ["startDate", "endDate"], out, true);
      const locations = valuesAt(n, "location").values as Node[];
      for (const loc of locations) {
        const types = loc && typeof loc === "object" ? typesOf(loc) : [];
        if (types.includes("VirtualLocation")) {
          if (isEmpty(loc.url)) out.push(missing("error", "location.url"));
        } else if (isEmpty(loc?.address)) {
          out.push(missing("error", "location.address"));
        }
      }
      if (valuesAt(n, "offers").present) {
        for (const p of ["offers.price", "offers.priceCurrency", "offers.availability", "offers.url", "offers.validFrom"]) if (!has(n, p)) out.push(missing("warning", p));
      }
      checkUrls(n, ["image", "offers.url", "organizer.url"], out);
    },
  },
};

function rulesFor(types: string[]): { name: string; rules: Rules } | null {
  for (const type of types) {
    if (RULES[type]) return { name: type, rules: RULES[type]! };
    if (ARTICLE_TYPES.has(type)) return { name: type, rules: RULES.Article! };
    if (LOCAL_BUSINESS_TYPES.has(type)) return { name: type, rules: RULES.LocalBusiness! };
  }
  return null;
}

/** Every typed node of a JSON-LD value, @graph containers opened. */
export function schemaNodes(value: unknown): Node[] {
  const out: Node[] = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== "object") return;
    const n = v as Node;
    if (n["@graph"] !== undefined) walk(n["@graph"]);
    if (typesOf(n).length) out.push(n);
  };
  walk(value);
  return out;
}

export function nodeTypes(node: Node): string[] {
  return typesOf(node);
}

export function validateNode(node: Node, opts: { topLevel?: boolean } = {}): SchemaIssue[] {
  const out: SchemaIssue[] = [];
  if (opts.topLevel !== false) {
    const ctx = node["@context"];
    const ok = typeof ctx === "string" ? /^https?:\/\/schema\.org\/?$/.test(ctx) : Boolean(ctx);
    if (!ok) out.push({ level: "error", code: "bad_context", path: "@context", message: t("«@context» باید https://schema.org باشد.", '"@context" must be https://schema.org.') });
  }
  const types = typesOf(node);
  if (!types.length) {
    out.push({ level: "error", code: "missing_type", path: "@type", message: t("«@type» مشخص نشده است.", '"@type" is missing.') });
    return out;
  }
  const found = rulesFor(types);
  if (!found) {
    out.push({ level: "info", code: "type_not_checked", path: "@type", message: t(`نوع «${types.join(", ")}» در فهرست بررسی گوگل این پنل نیست؛ فقط ساختار کلی بررسی شد.`, `Type "${types.join(", ")}" is not one this panel checks against Google's rules; only the general structure was checked.`) });
    return out;
  }
  for (const r of found.rules.required) if (!has(node, r)) out.push(missing("error", r));
  for (const r of found.rules.recommended) if (!has(node, r)) out.push(missing("warning", r));
  found.rules.check?.(node, out);
  // One problem reported once, even when two rules find it.
  const seen = new Set<string>();
  return out.filter((i) => {
    const k = `${i.level}:${i.code}:${i.path}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Validate a JSON-LD document (one object, an array, or a @graph container). */
export function validateJsonLd(value: unknown): Array<{ type: string; issues: SchemaIssue[] }> {
  const topContext = value && typeof value === "object" && !Array.isArray(value) ? (value as Node)["@context"] : undefined;
  return schemaNodes(value).map((node) => ({
    type: typesOf(node).join(", "),
    issues: validateNode(topContext && !node["@context"] ? { ...node, "@context": topContext } : node),
  }));
}
