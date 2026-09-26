/**
 * Code that runs inside the remote page, kept as plain JavaScript source.
 *
 * Functions handed to page.evaluate are serialised with toString(), and the
 * worker runs through tsx, whose esbuild transform wraps every named inner
 * function in a `__name(...)` helper that exists in Node but not in the page
 * (ReferenceError, silently turned into "no data"). Source strings are sent as
 * written.
 */

/** LCP and CLS from buffered PerformanceObservers (LCP is not in getEntriesByType), TTFB from navigation timing. */
export const METRICS_SCRIPT = `(async () => {
  const out = {};
  const nav = performance.getEntriesByType("navigation")[0];
  if (nav && nav.responseStart > 0) out.ttfbMs = Math.round(nav.responseStart);
  const collect = (type, onEntry) => new Promise((resolve) => {
    try {
      const po = new PerformanceObserver((list) => list.getEntries().forEach(onEntry));
      po.observe({ type, buffered: true });
      setTimeout(() => { po.takeRecords().forEach(onEntry); po.disconnect(); resolve(true); }, 60);
    } catch (e) { resolve(false); }
  });
  let lcp;
  let cls = 0;
  const results = await Promise.all([
    collect("largest-contentful-paint", (e) => { lcp = e.renderTime || e.loadTime || e.startTime; }),
    collect("layout-shift", (e) => { if (!e.hadRecentInput) cls += e.value || 0; }),
  ]);
  if (lcp !== undefined) out.lcpMs = Math.round(lcp);
  if (results[1]) out.cls = Math.round(cls * 1000) / 1000;
  return out;
})()`;

/**
 * Applies proposed changes (title, meta description, robots, canonical, h1,
 * img alt by src, JSON-LD) to the live DOM, outlines the visible ones, scrolls
 * the first into view, and returns how many took.
 */
export function applyChangesScript(changes: unknown): string {
  return `((list) => {
  const mark = (el) => { el.style.outline = "3px solid #2be08a"; el.style.outlineOffset = "2px"; };
  const meta = (name) => {
    let el = Array.from(document.querySelectorAll("meta[name]")).find((m) => (m.getAttribute("name") || "").toLowerCase() === name);
    if (!el) { el = document.createElement("meta"); el.setAttribute("name", name); document.head.appendChild(el); }
    return el;
  };
  let applied = 0;
  let firstVisible = null;
  for (const c of list) {
    if (c.field === "title") { document.title = c.value; applied++; }
    else if (c.field === "meta_description") { meta("description").setAttribute("content", c.value); applied++; }
    else if (c.field === "robots") { meta("robots").setAttribute("content", c.value); applied++; }
    else if (c.field === "canonical") {
      let link = Array.from(document.querySelectorAll("link[rel]")).find((l) => (l.getAttribute("rel") || "").toLowerCase().split(/\\s+/).includes("canonical"));
      if (!link) { link = document.createElement("link"); link.setAttribute("rel", "canonical"); document.head.appendChild(link); }
      link.setAttribute("href", c.value);
      applied++;
    } else if (c.field === "h1") {
      const h1 = document.querySelector("h1");
      if (h1) { h1.textContent = c.value; mark(h1); firstVisible = firstVisible || h1; applied++; }
    } else if (c.field === "img_alt") {
      const wanted = c.selector || "";
      let abs = wanted;
      try { abs = new URL(wanted, location.href).href; } catch (e) { /* compared as written */ }
      for (const img of Array.from(document.images)) {
        if ((img.getAttribute("src") || "") === wanted || img.src === abs || img.currentSrc === abs) {
          img.setAttribute("alt", c.value); mark(img); firstVisible = firstVisible || img; applied++;
        }
      }
    } else if (c.field === "jsonld") {
      const script = document.createElement("script");
      script.type = "application/ld+json";
      script.textContent = c.value;
      document.head.appendChild(script);
      applied++;
    }
  }
  if (firstVisible) firstVisible.scrollIntoView({ block: "center" });
  return applied;
})(${JSON.stringify(changes)})`;
}

/** The selected text (never from a password field, as browsers do), capped at `max` characters. */
export function selectionScript(max: number): string {
  return `(() => {
  const el = document.activeElement;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    if (el instanceof HTMLInputElement && el.type === "password") return "";
    return el.value.slice(el.selectionStart || 0, el.selectionEnd || 0).slice(0, ${Number(max)});
  }
  return String(window.getSelection() || "").slice(0, ${Number(max)});
})()`;
}
