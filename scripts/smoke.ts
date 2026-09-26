/**
 * Smoke test against a running deployment.
 *
 * Walks the real user path over HTTP — nothing is called in-process — so it is the
 * same check whether BASE_URL is localhost or production:
 *
 *   health → ready → login → create project → start scan → replay (idempotent)
 *   → overlap refused (409) → poll until the worker finishes → read issues,
 *   fixes and the approval queue → verify a restricted fix cannot be applied
 *   → verify an unauthenticated call is refused.
 *
 *   BASE_URL=https://app.example.com SMOKE_EMAIL=… SMOKE_PASSWORD=… \
 *   SMOKE_SITE=https://site-to-scan.example pnpm smoke
 */
const BASE = (process.env.BASE_URL ?? "http://localhost:3000").replace(/\/+$/, "");
const EMAIL = process.env.SMOKE_EMAIL ?? "owner@example.com";
const PASSWORD = process.env.SMOKE_PASSWORD ?? "";
const SITE = process.env.SMOKE_SITE ?? "http://127.0.0.1:4555";
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS ?? 180_000);

let cookie = "";
let failures = 0;

function pass(msg: string) {
  console.log(`  ✓ ${msg}`);
}
function fail(msg: string, detail?: unknown) {
  failures++;
  console.log(`  ✗ ${msg}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 300)}` : ""}`);
}
function check(cond: boolean, msg: string, detail?: unknown) {
  if (cond) pass(msg);
  else fail(msg, detail);
}

async function call(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; data: any }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    redirect: "manual",
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      // What a browser sends on a same-origin write; the API refuses cookie-
      // authenticated writes whose Origin is another site.
      ...(method !== "GET" && method !== "HEAD" ? { origin: BASE } : {}),
      ...(cookie ? { cookie } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie?.includes("seo_session=")) cookie = setCookie.split(";")[0]!;
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

async function main(): Promise<void> {
  console.log(`smoke → ${BASE}`);
  if (!PASSWORD) throw new Error("Set SMOKE_PASSWORD");

  console.log("platform");
  const health = await call("GET", "/api/health");
  check(health.status === 200 && health.data?.status === "ok", "GET /api/health is ok", health);
  const ready = await call("GET", "/api/ready");
  check(ready.status === 200 && ready.data?.checks?.database && ready.data?.checks?.redis, "database and redis are ready", ready.data);

  console.log("security");
  const anon = await call("GET", "/api/projects");
  check(anon.status === 401, "unauthenticated API call is refused (401)", anon.status);
  const badLogin = await call("POST", "/api/auth/login", { email: EMAIL, password: "definitely-wrong-password" });
  check(badLogin.status === 401, "wrong password is refused", badLogin.status);
  const page = await fetch(`${BASE}/`, { redirect: "manual" });
  check(page.status === 307 || page.status === 302, "anonymous page load redirects to /login", page.status);
  // Behind a proxy the server only knows its bind address; redirects must be
  // relative or the browser is sent to http://0.0.0.0:3000.
  for (const [path, method] of [["/", "GET"], ["/api/locale?set=en&next=/issues", "GET"], ["/api/auth/logout", "POST"]] as const) {
    const r = await fetch(`${BASE}${path}`, {
      method,
      redirect: "manual",
      headers: { "x-forwarded-host": "public.example", "x-forwarded-proto": "https" },
    });
    const loc = r.headers.get("location") ?? "";
    const ok = loc.startsWith("/") ? !loc.startsWith("//") : loc.startsWith("https://public.example/");
    check(ok, `${method} ${path} redirects to the public address (${loc})`, loc);
  }
  const evil = await fetch(`${BASE}/api/locale?set=en&next=//evil.example`, { redirect: "manual" });
  check(evil.headers.get("location") === "/", "locale switch refuses an off-site next", evil.headers.get("location"));

  console.log("auth");
  const login = await call("POST", "/api/auth/login", { email: EMAIL, password: PASSWORD });
  check(login.status === 200 && Boolean(cookie), "login sets a session cookie", login.data);
  if (!cookie) throw new Error("cannot continue without a session");

  const crossSite = await call("POST", "/api/projects", { name: "x", baseUrl: SITE }, { origin: "https://evil.example" });
  check(crossSite.status === 403, "a cross-site write with the session cookie is refused (403)", crossSite.status);

  console.log("project");
  const created = await call("POST", "/api/projects", {
    name: `Smoke ${new Date().toISOString()}`,
    baseUrl: SITE,
    pageCap: 100,
    crawlRate: 20,
  });
  check(created.status === 201, "project created", created.data);
  const projectId: string = created.data?.project?.id;

  console.log("scan");
  const key = `smoke-${Date.now()}`;
  const first = await call("POST", `/api/projects/${projectId}/scans`, {}, { "idempotency-key": key });
  check(first.status === 202 && first.data?.run?.id, "scan accepted (202)", first.data);
  const runId: string = first.data?.run?.id;

  const replay = await call("POST", `/api/projects/${projectId}/scans`, {}, { "idempotency-key": key });
  check(replay.status === 200 && replay.data?.replayed === true && replay.data?.run?.id === runId, "same Idempotency-Key returns the same run", replay.data);

  const overlap = await call("POST", `/api/projects/${projectId}/scans`, {}, { "idempotency-key": `${key}-2` });
  check(overlap.status === 409, "a second concurrent scan is refused (409)", overlap.data);

  // Only these are final: a failed attempt that will be retried puts the run
  // back to QUEUED, so FAILED/DEAD_LETTER mean the worker has given up.
  const FINAL = ["SUCCEEDED", "FAILED", "DEAD_LETTER", "CANCELED"];
  const started = Date.now();
  let status = "";
  let run: any = null;
  while (Date.now() - started < TIMEOUT_MS) {
    const res = await call("GET", `/api/scans/${runId}?pages=0`);
    run = res.data?.run;
    status = run?.status;
    if (FINAL.includes(status)) break;
    await new Promise((r) => setTimeout(r, 1500));
  }
  const elapsed = Math.round((Date.now() - started) / 1000);
  check(
    status === "SUCCEEDED",
    FINAL.includes(status)
      ? `worker finished the run (${status}, ${elapsed}s)`
      : `worker finished the run (still ${status} after ${elapsed}s; is the worker running?)`,
    run,
  );
  check(typeof run?.score === "number", `run has a score (${run?.score})`, run);
  check((run?.pagesCrawled ?? 0) > 0, `pages crawled (${run?.pagesCrawled})`, run);

  console.log("results");
  const full = await call("GET", `/api/scans/${runId}?perPage=5`);
  check(full.data?.pages?.total > 0, `snapshots readable (${full.data?.pages?.total})`, full.data?.pages);

  const issues = await call("GET", `/api/issues?projectId=${projectId}`);
  check(issues.status === 200 && issues.data?.total > 0, `issues found (${issues.data?.total})`, issues.data);

  const fixes = await call("GET", `/api/fixes?projectId=${projectId}`);
  check(fixes.status === 200, `fix proposals readable (${fixes.data?.fixes?.length ?? 0})`, fixes.status);

  const queue = await call("GET", `/api/approvals?projectId=${projectId}`);
  check(queue.status === 200, `approval queue readable (${queue.data?.queue?.length ?? 0})`, queue.status);

  console.log("safety");
  const restricted = (queue.data?.queue ?? []).find((q: any) =>
    ["REDIRECT", "URL_CHANGE", "PAGE_MERGE"].includes(q.proposal?.action),
  );
  if (restricted) {
    const attempt = await call("POST", `/api/fixes/${restricted.proposal.id}/apply`);
    check(
      attempt.status === 403 && attempt.data?.error?.details?.requiresApproval === true,
      `restricted ${restricted.proposal.action} cannot be applied without approval (403)`,
      attempt.data,
    );
  } else {
    pass("no restricted proposal on this site to test (skipped)");
  }

  const policy = await call("GET", "/api/settings/policy");
  check(
    JSON.stringify(policy.data?.policy?.neverWithoutApproval?.sort()) ===
      JSON.stringify(["PAGE_MERGE", "REDIRECT", "URL_CHANGE"]),
    "policy lists redirect / URL change / merge as never-without-approval",
    policy.data?.policy,
  );

  const log = await call("GET", "/api/audit-log?perPage=200");
  const actions = new Set((log.data?.entries ?? []).map((e: any) => e.action));
  check(actions.has("scan.enqueue") && actions.has("scan.refused_overlap"), "audit log recorded the scan and the refused overlap", [...actions]);

  console.log("pages");
  for (const path of ["/", "/projects", "/audit", "/issues", "/fixes", "/approvals", "/content", "/connectors", "/reports", "/settings", "/onboarding"]) {
    const res = await fetch(`${BASE}${path}`, { headers: { cookie }, redirect: "manual" });
    check(res.status === 200, `${path} renders (${res.status})`, res.status);
  }

  console.log(failures === 0 ? "\nSMOKE PASSED" : `\nSMOKE FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("smoke crashed:", err);
  process.exit(1);
});
