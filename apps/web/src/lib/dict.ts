import type { Locale } from "./i18n";

/**
 * A screen's own wording, in both languages. The English half is typed against
 * the Persian keys, so a missing translation is a compile error; the server
 * page picks one half and hands only that to its client components.
 *
 * Every dictionary is registered in ALL_DICTS (see dicts.ts) so the language
 * test checks it like the shared messages.
 */
export type Dict<K extends string> = Record<K, string>;

export function defineDict<const F extends Record<string, string>>(
  fa: F,
  en: { [K in keyof F]: string },
): Record<Locale, Dict<Extract<keyof F, string>>> {
  return { fa, en } as Record<Locale, Dict<Extract<keyof F, string>>>;
}

/** Fill {name} slots. */
export function fmt(template: string, vars: Record<string, string | number>): string {
  let out = template;
  for (const [k, v] of Object.entries(vars)) out = out.replaceAll(`{${k}}`, String(v));
  return out;
}
