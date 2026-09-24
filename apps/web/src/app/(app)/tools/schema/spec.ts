/**
 * The generator's forms: one field list per schema type, mirroring the
 * server's TEMPLATE_INPUTS (packages/seo-data/src/schema-markup/generate.ts).
 * The server validates the input again; this only decides what to ask for.
 */
export type Field =
  | { key: string; kind: "text" | "textarea" | "url" | "number" | "date" | "time" }
  | { key: string; kind: "urls" | "strings" }
  | { key: string; kind: "select"; options: string[] }
  | { key: string; kind: "multiselect"; options: string[] }
  | { key: string; kind: "object"; fields: Field[] }
  | { key: string; kind: "rows"; fields: Field[] };

const address: Field = {
  key: "address",
  kind: "object",
  fields: [
    { key: "streetAddress", kind: "text" },
    { key: "addressLocality", kind: "text" },
    { key: "addressRegion", kind: "text" },
    { key: "postalCode", kind: "text" },
    { key: "addressCountry", kind: "text" },
  ],
};

const rating: Field = {
  key: "aggregateRating",
  kind: "object",
  fields: [
    { key: "ratingValue", kind: "number" },
    { key: "ratingCount", kind: "number" },
    { key: "reviewCount", kind: "number" },
    { key: "bestRating", kind: "number" },
    { key: "worstRating", kind: "number" },
  ],
};

const offer: Field = {
  key: "offers",
  kind: "object",
  fields: [
    { key: "price", kind: "number" },
    { key: "priceCurrency", kind: "text" },
    { key: "availability", kind: "select", options: ["InStock", "OutOfStock", "PreOrder", "BackOrder", "Discontinued", "LimitedAvailability", "SoldOut", "OnlineOnly", "InStoreOnly"] },
    { key: "url", kind: "url" },
    { key: "priceValidUntil", kind: "date" },
    { key: "validFrom", kind: "date" },
    { key: "itemCondition", kind: "select", options: ["NewCondition", "UsedCondition", "RefurbishedCondition", "DamagedCondition"] },
  ],
};

const DAYS = ["Saturday", "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];

const article: Field[] = [
  { key: "headline", kind: "text" },
  { key: "description", kind: "textarea" },
  { key: "image", kind: "urls" },
  { key: "datePublished", kind: "date" },
  { key: "dateModified", kind: "date" },
  {
    key: "authors",
    kind: "rows",
    fields: [
      { key: "type", kind: "select", options: ["Person", "Organization"] },
      { key: "name", kind: "text" },
      { key: "url", kind: "url" },
    ],
  },
  { key: "publisher", kind: "object", fields: [{ key: "name", kind: "text" }, { key: "logo", kind: "url" }] },
  { key: "url", kind: "url" },
];

export const SPEC: Record<string, Field[]> = {
  Organization: [
    { key: "name", kind: "text" },
    { key: "legalName", kind: "text" },
    { key: "alternateName", kind: "text" },
    { key: "url", kind: "url" },
    { key: "logo", kind: "url" },
    { key: "description", kind: "textarea" },
    { key: "email", kind: "text" },
    { key: "telephone", kind: "text" },
    { key: "sameAs", kind: "urls" },
    address,
  ],
  LocalBusiness: [
    { key: "businessType", kind: "text" },
    { key: "name", kind: "text" },
    { key: "url", kind: "url" },
    { key: "image", kind: "urls" },
    { key: "description", kind: "textarea" },
    { key: "telephone", kind: "text" },
    { key: "priceRange", kind: "text" },
    address,
    { key: "geo", kind: "object", fields: [{ key: "latitude", kind: "number" }, { key: "longitude", kind: "number" }] },
    {
      key: "openingHours",
      kind: "rows",
      fields: [
        { key: "days", kind: "multiselect", options: DAYS },
        { key: "opens", kind: "time" },
        { key: "closes", kind: "time" },
      ],
    },
    { key: "servesCuisine", kind: "text" },
    { key: "menu", kind: "url" },
    { key: "sameAs", kind: "urls" },
    rating,
  ],
  WebSite: [
    { key: "name", kind: "text" },
    { key: "alternateName", kind: "text" },
    { key: "url", kind: "url" },
    { key: "searchUrlTemplate", kind: "url" },
  ],
  BreadcrumbList: [{ key: "items", kind: "rows", fields: [{ key: "name", kind: "text" }, { key: "url", kind: "url" }] }],
  Article: article,
  BlogPosting: article,
  NewsArticle: article,
  Product: [
    { key: "name", kind: "text" },
    { key: "description", kind: "textarea" },
    { key: "image", kind: "urls" },
    { key: "sku", kind: "text" },
    { key: "gtin", kind: "text" },
    { key: "mpn", kind: "text" },
    { key: "brand", kind: "text" },
    { key: "url", kind: "url" },
    offer,
    rating,
  ],
  FAQPage: [{ key: "items", kind: "rows", fields: [{ key: "question", kind: "text" }, { key: "answer", kind: "textarea" }] }],
  HowTo: [
    { key: "name", kind: "text" },
    { key: "description", kind: "textarea" },
    { key: "image", kind: "urls" },
    { key: "totalTime", kind: "text" },
    { key: "supplies", kind: "strings" },
    { key: "tools", kind: "strings" },
    {
      key: "steps",
      kind: "rows",
      fields: [
        { key: "name", kind: "text" },
        { key: "text", kind: "textarea" },
        { key: "url", kind: "url" },
        { key: "image", kind: "url" },
      ],
    },
  ],
  Person: [
    { key: "name", kind: "text" },
    { key: "url", kind: "url" },
    { key: "image", kind: "url" },
    { key: "jobTitle", kind: "text" },
    { key: "worksFor", kind: "text" },
    { key: "description", kind: "textarea" },
    { key: "sameAs", kind: "urls" },
  ],
  Event: [
    { key: "name", kind: "text" },
    { key: "description", kind: "textarea" },
    { key: "image", kind: "urls" },
    { key: "startDate", kind: "date" },
    { key: "endDate", kind: "date" },
    { key: "eventStatus", kind: "select", options: ["EventScheduled", "EventCancelled", "EventPostponed", "EventRescheduled", "EventMovedOnline"] },
    { key: "attendanceMode", kind: "select", options: ["offline", "online", "mixed"] },
    { key: "location", kind: "object", fields: [{ key: "name", kind: "text" }, address, { key: "url", kind: "url" }] },
    { key: "organizer", kind: "object", fields: [{ key: "name", kind: "text" }, { key: "url", kind: "url" }] },
    { key: "performer", kind: "text" },
    offer,
  ],
};

/** Row fields the server requires (a question needs its answer, a step its text). */
const REQUIRED_IN_ROWS = new Set(["name", "question", "answer", "text", "days", "opens", "closes"]);

/**
 * The required row fields left empty in rows that are otherwise started — the
 * form asks for them instead of sending markup the server would refuse.
 */
export function missingRowFields(fields: Field[], data: Record<string, unknown>): string[] {
  const out = new Set<string>();
  for (const f of fields) {
    if (f.kind !== "rows") continue;
    // A list, a breadcrumb trail and a how-to need at least one row.
    if ((f.key === "items" || f.key === "steps") && !(Array.isArray(data[f.key]) && (data[f.key] as unknown[]).length)) out.add(f.key);
    if (!Array.isArray(data[f.key])) continue;
    for (const row of data[f.key] as Array<Record<string, unknown>>) {
      const filled = (v: unknown) => (Array.isArray(v) ? v.length > 0 : typeof v === "number" || (typeof v === "string" && v.trim() !== ""));
      if (!Object.values(row).some(filled)) continue;
      for (const sub of f.fields) if (REQUIRED_IN_ROWS.has(sub.key) && !filled(row[sub.key])) out.add(sub.key);
    }
  }
  return [...out];
}

/** An empty row for a repeatable group. */
export function emptyRow(fields: Field[]): Record<string, unknown> {
  return Object.fromEntries(fields.map((f) => [f.key, f.kind === "multiselect" || f.kind === "urls" || f.kind === "strings" ? [] : ""]));
}
