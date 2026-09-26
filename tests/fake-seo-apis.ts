/**
 * HTTP doubles for the third-party APIs behind the SEO data features, speaking
 * each API's real request and response shapes:
 *
 *   DataForSEO     Basic auth, the v3 task envelope, status codes 20000 / 40100 /
 *                  40210, per-request `cost`
 *   PageSpeed      /runPagespeed with a Lighthouse result and CrUX field data;
 *                  can answer 429 a set number of times first
 *   Telegram       /bot<token>/getMe|getChat|sendMessage with {ok, result}
 *   Google Suggest ["seed", [suggestions…]]
 *   webhook        a receiver that records each request with its raw body
 *
 * Every double records what it received, so tests assert on the requests the
 * code actually made. Knobs change behaviour while the server runs.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export type Received = { method: string; path: string; headers: IncomingMessage["headers"]; body: string };

export type Fake<K> = {
  url: string;
  received: Received[];
  knobs: K;
  close: () => Promise<void>;
};

async function serve<K>(
  knobs: K,
  handle: (req: Received, res: ServerResponse, knobs: K) => void,
): Promise<Fake<K>> {
  const received: Received[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const r = { method: req.method ?? "GET", path: req.url ?? "/", headers: req.headers, body: Buffer.concat(chunks).toString("utf8") };
      received.push(r);
      handle(r, res, knobs);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}`,
    received,
    knobs,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

// ---------------------------------------------------------------- DataForSEO

export type DataForSeoKnobs = {
  login: string;
  password: string;
  balance: number;
  /** Organic results per keyword for SERP calls: [{domain, url}] in rank order. */
  serp: Map<string, Array<{ domain: string; url: string }>>;
  features: string[];
  /** Ranked keywords per target domain. */
  ranked: Map<string, Array<{ keyword: string; position: number; volume: number; url: string }>>;
  /** When set, every task answers this status code (40210 = out of funds). */
  taskStatus: number | null;
  cost: number;
};

export function fakeDataForSeo(overrides: Partial<DataForSeoKnobs> = {}) {
  const knobs: DataForSeoKnobs = {
    login: "api@agency.example",
    password: "s3cret-pass",
    balance: 12.5,
    serp: new Map(),
    features: ["featured_snippet", "people_also_ask"],
    ranked: new Map(),
    taskStatus: null,
    cost: 0.002,
    ...overrides,
  };
  return serve(knobs, (req, res, k) => {
    const expected = `Basic ${Buffer.from(`${k.login}:${k.password}`).toString("base64")}`;
    if (req.headers.authorization !== expected) {
      json(res, 401, { version: "0.1", status_code: 40100, status_message: "You are not authorized to access this resource.", tasks: [] });
      return;
    }
    const path = req.path.replace(/^\/v3\//, "").replace(/^\//, "");
    const task = req.body ? ((JSON.parse(req.body) as Array<Record<string, unknown>>)[0] ?? {}) : {};
    const envelope = (result: unknown[]) =>
      json(res, 200, {
        version: "0.1.20250101",
        status_code: 20000,
        status_message: "Ok.",
        cost: k.cost,
        tasks_count: 1,
        tasks_error: k.taskStatus ? 1 : 0,
        tasks: [
          k.taskStatus
            ? { id: "t1", status_code: k.taskStatus, status_message: k.taskStatus === 40210 ? "Insufficient funds." : "Error.", cost: 0, result: null }
            : { id: "t1", status_code: 20000, status_message: "Ok.", cost: k.cost, result_count: result.length, path: path.split("/"), data: task, result },
        ],
      });
    switch (path) {
      case "appendix/user_data":
        envelope([{ login: k.login, timezone: "UTC", money: { total: 50, balance: k.balance } }]);
        return;
      case "keywords_data/google_ads/search_volume/live":
        envelope(
          (task.keywords as string[]).map((kw, i) => ({
            keyword: kw,
            location_code: task.location_code,
            language_code: task.language_code,
            search_volume: 1000 * (i + 1),
            cpc: 0.5,
            competition_index: 40,
            monthly_searches: [{ year: 2026, month: 8, search_volume: 900 }],
          })),
        );
        return;
      case "dataforseo_labs/google/keyword_ideas/live":
        envelope([
          {
            items: (task.keywords as string[]).flatMap((seed) => [
              { keyword: `${seed} online`, keyword_info: { search_volume: 880, cpc: 0.3, competition: 0.42 }, keyword_properties: { keyword_difficulty: 31 } },
              { keyword: `best ${seed}`, keyword_info: { search_volume: 1600, cpc: 0.9, competition: 0.7 }, keyword_properties: { keyword_difficulty: 55 } },
            ]),
          },
        ]);
        return;
      case "dataforseo_labs/google/bulk_keyword_difficulty/live":
        envelope([{ items: (task.keywords as string[]).map((kw) => ({ keyword: kw, keyword_difficulty: 42 })) }]);
        return;
      case "dataforseo_labs/google/ranked_keywords/live": {
        const list = k.ranked.get(String(task.target)) ?? [];
        envelope([
          {
            items: list.map((r) => ({
              keyword_data: { keyword: r.keyword, keyword_info: { search_volume: r.volume }, keyword_properties: { keyword_difficulty: 20 } },
              ranked_serp_element: { serp_item: { type: "organic", rank_group: r.position, url: r.url } },
            })),
          },
        ]);
        return;
      }
      case "serp/google/organic/live/advanced": {
        const organic = k.serp.get(String(task.keyword)) ?? [];
        envelope([
          {
            keyword: task.keyword,
            location_code: task.location_code,
            language_code: task.language_code,
            item_types: ["organic", ...k.features],
            se_results_count: 123000,
            items: [
              ...k.features.map((f, i) => ({ type: f, rank_group: 1, rank_absolute: i + 1 })),
              ...organic.map((o, i) => ({
                type: "organic",
                rank_group: i + 1,
                rank_absolute: k.features.length + i + 1,
                domain: o.domain,
                url: o.url,
                title: `Result ${i + 1}`,
              })),
            ],
          },
        ]);
        return;
      }
      case "backlinks/summary/live":
        envelope([{ target: task.target, rank: 310, backlinks: 5400, referring_domains: 220, referring_main_domains: 190, broken_backlinks: 12, backlinks_spam_score: 4 }]);
        return;
      default:
        json(res, 404, { status_code: 40400, status_message: "Not Found." });
    }
  });
}

// ---------------------------------------------------------------- PageSpeed Insights

export type PsiKnobs = {
  /** Answer 429 this many times before succeeding. */
  throttle: number;
  /** Performance score (0–1) per URL; default 0.9. */
  scores: Map<string, number>;
  lcpMs: number;
  cls: number;
  /** Include CrUX field data (page-level). */
  field: boolean;
  fieldLcpMs: number;
  validKey: string | null;
};

export function psiResponse(url: string, k: Pick<PsiKnobs, "lcpMs" | "cls" | "field" | "fieldLcpMs"> & { score: number }) {
  const metrics = {
    LARGEST_CONTENTFUL_PAINT_MS: { percentile: k.fieldLcpMs, category: k.fieldLcpMs <= 2500 ? "FAST" : k.fieldLcpMs <= 4000 ? "AVERAGE" : "SLOW" },
    CUMULATIVE_LAYOUT_SHIFT_SCORE: { percentile: 5, category: "FAST" },
    INTERACTION_TO_NEXT_PAINT: { percentile: 180, category: "FAST" },
    FIRST_CONTENTFUL_PAINT_MS: { percentile: 1200, category: "FAST" },
    EXPERIMENTAL_TIME_TO_FIRST_BYTE: { percentile: 600, category: "FAST" },
  };
  return {
    id: url,
    loadingExperience: k.field ? { id: url, metrics, overall_category: "FAST" } : { id: url },
    originLoadingExperience: k.field ? { id: new URL(url).origin, metrics, overall_category: "FAST" } : undefined,
    lighthouseResult: {
      finalUrl: url,
      categories: { performance: { score: k.score } },
      audits: {
        "largest-contentful-paint": { id: "largest-contentful-paint", score: 0.8, numericValue: k.lcpMs },
        "cumulative-layout-shift": { id: "cumulative-layout-shift", score: 1, numericValue: k.cls },
        "first-contentful-paint": { id: "first-contentful-paint", score: 0.9, numericValue: 1100.4 },
        "total-blocking-time": { id: "total-blocking-time", score: 0.7, numericValue: 250.6 },
        "server-response-time": { id: "server-response-time", score: 1, numericValue: 310.2 },
        "render-blocking-resources": {
          id: "render-blocking-resources",
          title: "Eliminate render-blocking resources",
          score: 0.3,
          details: { type: "opportunity", overallSavingsMs: 870, overallSavingsBytes: 0 },
        },
        "unused-javascript": {
          id: "unused-javascript",
          title: "Reduce unused JavaScript",
          score: 0.5,
          details: { type: "opportunity", overallSavingsMs: 450, overallSavingsBytes: 120000 },
        },
        "uses-text-compression": { id: "uses-text-compression", title: "Enable text compression", score: 1, details: { type: "opportunity", overallSavingsMs: 0 } },
      },
    },
  };
}

export function fakePageSpeed(overrides: Partial<PsiKnobs> = {}) {
  const knobs: PsiKnobs = { throttle: 0, scores: new Map(), lcpMs: 2100, cls: 0.05, field: true, fieldLcpMs: 2300, validKey: null, ...overrides };
  return serve(knobs, (req, res, k) => {
    const u = new URL(req.path, "http://x");
    if (u.pathname !== "/runPagespeed") return json(res, 404, { error: { code: 404, message: "Not Found" } });
    if (k.validKey !== null && u.searchParams.get("key") !== k.validKey) {
      return json(res, 400, { error: { code: 400, message: "API key not valid. Please pass a valid API key.", errors: [{ reason: "badRequest" }] } });
    }
    if (k.throttle > 0) {
      k.throttle--;
      return json(res, 429, { error: { code: 429, message: "Quota exceeded" } }, { "retry-after": "0" });
    }
    const url = u.searchParams.get("url")!;
    json(res, 200, psiResponse(url, { ...k, score: k.scores.get(url) ?? 0.9 }));
  });
}

// ---------------------------------------------------------------- Telegram

export type TelegramKnobs = { token: string; chats: Set<string>; sent: Array<{ chatId: string; text: string }> };

export function fakeTelegram(overrides: Partial<TelegramKnobs> = {}) {
  const knobs: TelegramKnobs = { token: "123456789:AAH-fake-token-with-enough-length_x", chats: new Set(["-1001234"]), sent: [], ...overrides };
  return serve(knobs, (req, res, k) => {
    const m = /^\/bot([^/]+)\/(\w+)$/.exec(req.path);
    if (!m || m[1] !== k.token) return json(res, 401, { ok: false, error_code: 401, description: "Unauthorized" });
    const body = req.body ? (JSON.parse(req.body) as Record<string, unknown>) : {};
    switch (m[2]) {
      case "getMe":
        return json(res, 200, { ok: true, result: { id: 1, is_bot: true, first_name: "SEO", username: "seo_table_bot" } });
      case "getChat":
        if (!k.chats.has(String(body.chat_id))) return json(res, 400, { ok: false, error_code: 400, description: "Bad Request: chat not found" });
        return json(res, 200, { ok: true, result: { id: Number(body.chat_id), title: "SEO alerts", type: "supergroup" } });
      case "sendMessage":
        if (!k.chats.has(String(body.chat_id))) return json(res, 400, { ok: false, error_code: 400, description: "Bad Request: chat not found" });
        k.sent.push({ chatId: String(body.chat_id), text: String(body.text) });
        return json(res, 200, { ok: true, result: { message_id: k.sent.length } });
      default:
        return json(res, 404, { ok: false, error_code: 404, description: "Not Found" });
    }
  });
}

// ---------------------------------------------------------------- Google Suggest

export function fakeSuggest(suggestions: Record<string, string[]> = {}) {
  return serve({ suggestions }, (req, res, k) => {
    const q = new URL(req.path, "http://x").searchParams.get("q") ?? "";
    json(res, 200, [q, k.suggestions[q] ?? [`${q} 1`, `${q} 2`], [], { "google:suggesttype": [] }]);
  });
}

// ---------------------------------------------------------------- webhook receiver

export function fakeWebhook(overrides: { status?: number } = {}) {
  return serve({ status: overrides.status ?? 200 }, (_req, res, k) => json(res, k.status, { received: true }));
}
