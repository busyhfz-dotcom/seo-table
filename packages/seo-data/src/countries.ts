/**
 * Country codes in the three spellings the data sources use:
 *   - ISO 3166-1 alpha-2 ("IR") — how the panel stores a keyword's market;
 *   - alpha-3 lower case ("irn") — Search Console's `country` dimension;
 *   - Google Ads geo target id ("2364") — DataForSEO's `location_code`, which
 *     for a country is 2000 + the ISO 3166-1 numeric code.
 *
 * The list covers the markets a Persian/English SEO panel is realistically used
 * for; a country outside it can still be tracked through Search Console only
 * after it is added here (alpha-3 is required for the filter).
 */
const TABLE: Array<[alpha2: string, alpha3: string, numeric: number]> = [
  ["IR", "irn", 364], ["AF", "afg", 4], ["TJ", "tjk", 762], ["IQ", "irq", 368], ["TR", "tur", 792],
  ["AE", "are", 784], ["SA", "sau", 682], ["QA", "qat", 634], ["KW", "kwt", 414], ["BH", "bhr", 48],
  ["OM", "omn", 512], ["AZ", "aze", 31], ["AM", "arm", 51], ["GE", "geo", 268], ["PK", "pak", 586],
  ["IN", "ind", 356], ["US", "usa", 840], ["CA", "can", 124], ["GB", "gbr", 826], ["IE", "irl", 372],
  ["DE", "deu", 276], ["FR", "fra", 250], ["NL", "nld", 528], ["BE", "bel", 56], ["AT", "aut", 40],
  ["CH", "che", 756], ["SE", "swe", 752], ["NO", "nor", 578], ["DK", "dnk", 208], ["FI", "fin", 246],
  ["IT", "ita", 380], ["ES", "esp", 724], ["PT", "prt", 620], ["PL", "pol", 616], ["CZ", "cze", 203],
  ["HU", "hun", 348], ["RO", "rou", 642], ["GR", "grc", 300], ["CY", "cyp", 196], ["RU", "rus", 643],
  ["UA", "ukr", 804], ["KZ", "kaz", 398], ["UZ", "uzb", 860], ["TM", "tkm", 795], ["EG", "egy", 818],
  ["JO", "jor", 400], ["LB", "lbn", 422], ["IL", "isr", 376], ["MA", "mar", 504], ["DZ", "dza", 12],
  ["TN", "tun", 788], ["ZA", "zaf", 710], ["NG", "nga", 566], ["KE", "ken", 404], ["AU", "aus", 36],
  ["NZ", "nzl", 554], ["JP", "jpn", 392], ["KR", "kor", 410], ["CN", "chn", 156], ["HK", "hkg", 344],
  ["SG", "sgp", 702], ["MY", "mys", 458], ["ID", "idn", 360], ["TH", "tha", 764], ["VN", "vnm", 704],
  ["PH", "phl", 608], ["BR", "bra", 76], ["MX", "mex", 484], ["AR", "arg", 32], ["CL", "chl", 152],
  ["CO", "col", 170],
];

const BY_ALPHA2 = new Map(TABLE.map(([a2, a3, n]) => [a2, { alpha3: a3, numeric: n }]));

export function isSupportedCountry(alpha2: string): boolean {
  return BY_ALPHA2.has(alpha2.toUpperCase());
}

export const SUPPORTED_COUNTRIES: readonly string[] = TABLE.map(([a2]) => a2);

/** Search Console's country filter value, or null when the country is unknown. */
export function gscCountry(alpha2: string): string | null {
  return BY_ALPHA2.get(alpha2.toUpperCase())?.alpha3 ?? null;
}

/** DataForSEO / Google Ads location_code for a country. */
export function dataForSeoLocation(alpha2: string): number | null {
  const n = BY_ALPHA2.get(alpha2.toUpperCase())?.numeric;
  return n === undefined ? null : 2000 + n;
}
