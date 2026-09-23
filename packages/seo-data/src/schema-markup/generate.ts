/**
 * JSON-LD from a form: one input shape per template, turned into schema.org
 * markup with empty fields left out (an empty property is worse than none).
 * Nothing is invented — a rating, a price or an address appears only when the
 * person entered it (or it was read from the page itself, see prefill).
 */
import { z } from "zod";
import type { SchemaType } from "./validate.js";

const text = z.string().trim().max(5000).optional().nullable();
const short = z.string().trim().max(500).optional().nullable();
const url = z.string().trim().max(2000).optional().nullable();
const urls = z.array(z.string().trim().max(2000)).max(20).optional();
const num = z.union([z.number(), z.string().trim().max(40)]).optional().nullable();

const address = z
  .object({
    streetAddress: short,
    addressLocality: short,
    addressRegion: short,
    postalCode: short,
    addressCountry: short,
  })
  .optional()
  .nullable();

const rating = z
  .object({ ratingValue: num, ratingCount: num, reviewCount: num, bestRating: num, worstRating: num })
  .optional()
  .nullable();

const offer = z
  .object({
    price: num,
    priceCurrency: short,
    availability: z.enum(["InStock", "OutOfStock", "PreOrder", "BackOrder", "Discontinued", "LimitedAvailability", "SoldOut", "OnlineOnly", "InStoreOnly"]).optional().nullable(),
    url,
    priceValidUntil: short,
    validFrom: short,
    itemCondition: z.enum(["NewCondition", "UsedCondition", "RefurbishedCondition", "DamagedCondition"]).optional().nullable(),
  })
  .optional()
  .nullable();

const person = z.object({ type: z.enum(["Person", "Organization"]).optional(), name: short, url });

export const TEMPLATE_INPUTS = {
  Organization: z.object({ name: short, legalName: short, alternateName: short, url, logo: url, description: text, email: short, telephone: short, sameAs: urls, address }),
  LocalBusiness: z.object({
    businessType: z.string().trim().regex(/^[A-Z][A-Za-z]+$/).max(60).optional().nullable(),
    name: short,
    url,
    image: urls,
    description: text,
    telephone: short,
    priceRange: short,
    address,
    geo: z.object({ latitude: num, longitude: num }).optional().nullable(),
    openingHours: z
      .array(
        z.object({
          days: z.array(z.enum(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"])).min(1),
          opens: z.string().regex(/^\d{2}:\d{2}$/),
          closes: z.string().regex(/^\d{2}:\d{2}$/),
        }),
      )
      .max(14)
      .optional(),
    servesCuisine: short,
    menu: url,
    sameAs: urls,
    aggregateRating: rating,
  }),
  WebSite: z.object({ name: short, alternateName: short, url, searchUrlTemplate: url }),
  BreadcrumbList: z.object({ items: z.array(z.object({ name: z.string().trim().min(1).max(200), url })).min(1).max(20) }),
  Article: z.object({
    headline: short,
    description: text,
    image: urls,
    datePublished: short,
    dateModified: short,
    authors: z.array(person).max(10).optional(),
    publisher: z.object({ name: short, logo: url }).optional().nullable(),
    url,
  }),
  Product: z.object({
    name: short,
    description: text,
    image: urls,
    sku: short,
    gtin: short,
    mpn: short,
    brand: short,
    url,
    offers: offer,
    aggregateRating: rating,
  }),
  FAQPage: z.object({ items: z.array(z.object({ question: z.string().trim().min(1).max(500), answer: z.string().trim().min(1).max(5000) })).min(1).max(50) }),
  HowTo: z.object({
    name: short,
    description: text,
    image: urls,
    totalTime: short,
    supplies: z.array(z.string().trim().max(200)).max(50).optional(),
    tools: z.array(z.string().trim().max(200)).max(50).optional(),
    steps: z.array(z.object({ name: short, text: z.string().trim().min(1).max(2000), url, image: url })).min(1).max(50),
  }),
  Person: z.object({ name: short, url, image: url, jobTitle: short, worksFor: short, description: text, sameAs: urls }),
  Event: z.object({
    name: short,
    description: text,
    image: urls,
    startDate: short,
    endDate: short,
    eventStatus: z.enum(["EventScheduled", "EventCancelled", "EventPostponed", "EventRescheduled", "EventMovedOnline"]).optional().nullable(),
    attendanceMode: z.enum(["offline", "online", "mixed"]).optional().nullable(),
    location: z.object({ name: short, address, url }).optional().nullable(),
    organizer: z.object({ name: short, url }).optional().nullable(),
    performer: short,
    offers: offer,
  }),
} as const;

export type TemplateInput<T extends keyof typeof TEMPLATE_INPUTS> = z.infer<(typeof TEMPLATE_INPUTS)[T]>;

type Json = Record<string, unknown>;

/** Drop empty strings, nulls, empty arrays and objects that end up empty. */
function clean<T>(v: T): T | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === "string") return (v.trim() === "" ? undefined : v.trim()) as T;
  if (Array.isArray(v)) {
    const arr = v.map(clean).filter((x) => x !== undefined);
    return (arr.length ? arr : undefined) as T;
  }
  if (typeof v === "object") {
    const out: Json = {};
    for (const [k, val] of Object.entries(v as Json)) {
      const c = clean(val);
      if (c !== undefined) out[k] = c;
    }
    const meaningful = Object.keys(out).filter((k) => k !== "@type");
    return (meaningful.length ? out : undefined) as T;
  }
  return v;
}

const numberOr = (v: string | number | null | undefined) => (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v);
const one = <T>(list: T[] | undefined) => (list && list.length === 1 ? list[0] : list);

function postal(a: TemplateInput<"Organization">["address"]) {
  return a ? { "@type": "PostalAddress", ...a } : undefined;
}

function aggregate(r: TemplateInput<"Product">["aggregateRating"]) {
  if (!r) return undefined;
  return {
    "@type": "AggregateRating",
    ratingValue: numberOr(r.ratingValue),
    ratingCount: numberOr(r.ratingCount),
    reviewCount: numberOr(r.reviewCount),
    bestRating: numberOr(r.bestRating),
    worstRating: numberOr(r.worstRating),
  };
}

function offerOf(o: TemplateInput<"Product">["offers"]) {
  if (!o) return undefined;
  return {
    "@type": "Offer",
    price: numberOr(o.price),
    priceCurrency: o.priceCurrency,
    availability: o.availability ? `https://schema.org/${o.availability}` : undefined,
    itemCondition: o.itemCondition ? `https://schema.org/${o.itemCondition}` : undefined,
    url: o.url,
    priceValidUntil: o.priceValidUntil,
    validFrom: o.validFrom,
  };
}

export function buildJsonLd(type: SchemaType, raw: unknown): Json {
  const ctx = { "@context": "https://schema.org" };
  switch (type) {
    case "Organization": {
      const d = TEMPLATE_INPUTS.Organization.parse(raw);
      return clean({ ...ctx, "@type": "Organization", name: d.name, legalName: d.legalName, alternateName: d.alternateName, url: d.url, logo: d.logo, description: d.description, email: d.email, telephone: d.telephone, sameAs: d.sameAs, address: postal(d.address) }) ?? { ...ctx, "@type": type };
    }
    case "LocalBusiness": {
      const d = TEMPLATE_INPUTS.LocalBusiness.parse(raw);
      return (
        clean({
          ...ctx,
          "@type": d.businessType || "LocalBusiness",
          name: d.name,
          url: d.url,
          image: one(d.image),
          description: d.description,
          telephone: d.telephone,
          priceRange: d.priceRange,
          address: postal(d.address),
          geo: d.geo ? { "@type": "GeoCoordinates", latitude: numberOr(d.geo.latitude), longitude: numberOr(d.geo.longitude) } : undefined,
          openingHoursSpecification: d.openingHours?.map((h) => ({ "@type": "OpeningHoursSpecification", dayOfWeek: h.days, opens: h.opens, closes: h.closes })),
          servesCuisine: d.servesCuisine,
          menu: d.menu,
          sameAs: d.sameAs,
          aggregateRating: aggregate(d.aggregateRating),
        }) ?? { ...ctx, "@type": type }
      );
    }
    case "WebSite": {
      const d = TEMPLATE_INPUTS.WebSite.parse(raw);
      return (
        clean({
          ...ctx,
          "@type": "WebSite",
          name: d.name,
          alternateName: d.alternateName,
          url: d.url,
          potentialAction: d.searchUrlTemplate
            ? { "@type": "SearchAction", target: { "@type": "EntryPoint", urlTemplate: d.searchUrlTemplate }, "query-input": "required name=search_term_string" }
            : undefined,
        }) ?? { ...ctx, "@type": type }
      );
    }
    case "BreadcrumbList": {
      const d = TEMPLATE_INPUTS.BreadcrumbList.parse(raw);
      return {
        ...ctx,
        "@type": "BreadcrumbList",
        itemListElement: d.items.map((it, i) => clean({ "@type": "ListItem", position: i + 1, name: it.name, item: it.url })),
      };
    }
    case "Article":
    case "BlogPosting":
    case "NewsArticle": {
      const d = TEMPLATE_INPUTS.Article.parse(raw);
      return (
        clean({
          ...ctx,
          "@type": type,
          headline: d.headline,
          description: d.description,
          image: d.image,
          datePublished: d.datePublished,
          dateModified: d.dateModified,
          author: one(d.authors?.map((a) => ({ "@type": a.type ?? "Person", name: a.name, url: a.url }))),
          publisher: d.publisher ? { "@type": "Organization", name: d.publisher.name, logo: d.publisher.logo ? { "@type": "ImageObject", url: d.publisher.logo } : undefined } : undefined,
          mainEntityOfPage: d.url ? { "@type": "WebPage", "@id": d.url } : undefined,
        }) ?? { ...ctx, "@type": type }
      );
    }
    case "Product": {
      const d = TEMPLATE_INPUTS.Product.parse(raw);
      return (
        clean({
          ...ctx,
          "@type": "Product",
          name: d.name,
          description: d.description,
          image: d.image,
          sku: d.sku,
          gtin: d.gtin,
          mpn: d.mpn,
          brand: d.brand ? { "@type": "Brand", name: d.brand } : undefined,
          url: d.url,
          offers: offerOf(d.offers),
          aggregateRating: aggregate(d.aggregateRating),
        }) ?? { ...ctx, "@type": type }
      );
    }
    case "FAQPage": {
      const d = TEMPLATE_INPUTS.FAQPage.parse(raw);
      return {
        ...ctx,
        "@type": "FAQPage",
        mainEntity: d.items.map((q) => ({ "@type": "Question", name: q.question, acceptedAnswer: { "@type": "Answer", text: q.answer } })),
      };
    }
    case "HowTo": {
      const d = TEMPLATE_INPUTS.HowTo.parse(raw);
      return (
        clean({
          ...ctx,
          "@type": "HowTo",
          name: d.name,
          description: d.description,
          image: one(d.image),
          totalTime: d.totalTime,
          supply: d.supplies?.map((s) => ({ "@type": "HowToSupply", name: s })),
          tool: d.tools?.map((s) => ({ "@type": "HowToTool", name: s })),
          step: d.steps.map((s) => ({ "@type": "HowToStep", name: s.name, text: s.text, url: s.url, image: s.image })),
        }) ?? { ...ctx, "@type": type }
      );
    }
    case "Person": {
      const d = TEMPLATE_INPUTS.Person.parse(raw);
      return (
        clean({
          ...ctx,
          "@type": "Person",
          name: d.name,
          url: d.url,
          image: d.image,
          jobTitle: d.jobTitle,
          worksFor: d.worksFor ? { "@type": "Organization", name: d.worksFor } : undefined,
          description: d.description,
          sameAs: d.sameAs,
        }) ?? { ...ctx, "@type": type }
      );
    }
    case "Event": {
      const d = TEMPLATE_INPUTS.Event.parse(raw);
      const mode = d.attendanceMode ?? "offline";
      const place = d.location ? { "@type": "Place", name: d.location.name, address: postal(d.location.address) } : undefined;
      const virtual = d.location?.url ? { "@type": "VirtualLocation", url: d.location.url } : undefined;
      const location = mode === "online" ? virtual : mode === "mixed" ? [place, virtual].filter(Boolean) : place;
      return (
        clean({
          ...ctx,
          "@type": "Event",
          name: d.name,
          description: d.description,
          image: d.image,
          startDate: d.startDate,
          endDate: d.endDate,
          eventStatus: d.eventStatus ? `https://schema.org/${d.eventStatus}` : undefined,
          eventAttendanceMode: `https://schema.org/${mode === "online" ? "OnlineEventAttendanceMode" : mode === "mixed" ? "MixedEventAttendanceMode" : "OfflineEventAttendanceMode"}`,
          location,
          organizer: d.organizer ? { "@type": "Organization", ...d.organizer } : undefined,
          performer: d.performer ? { "@type": "PerformingGroup", name: d.performer } : undefined,
          offers: offerOf(d.offers),
        }) ?? { ...ctx, "@type": type }
      );
    }
  }
}
