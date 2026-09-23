/** Fix fields the in-panel render can apply for a preview, as the render names them. */
export const RENDER_FIELD: Record<string, string> = {
  title: "title",
  meta_description: "meta_description",
  canonical: "canonical",
  meta_robots: "robots",
  "img.alt": "img_alt",
};

/** Whether any change in a proposal shows on the page itself (an image needs its src). */
export function previewable(changes: Array<{ field: string; selector?: string }>): boolean {
  return changes.some((c) => RENDER_FIELD[c.field] && (c.field !== "img.alt" || c.selector));
}
