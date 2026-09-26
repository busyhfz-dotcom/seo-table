import { z } from "zod";
import { enforce, NotFound } from "@seo/core";
import { handler } from "../../../../../../lib/route";
import { callWorker, SESSION_ID, workerJson } from "../../../_lib/worker";

// The worker validates every action exactly (key whitelist, coordinates, text
// length); this only keeps obvious junk from making the trip.
const schema = z
  .object({ type: z.enum(["navigate", "click", "type", "key", "scroll", "back", "forward", "reload"]) })
  .passthrough();

/**
 * One input for the remote page: {type:"navigate", url} | {type:"click", x, y}
 * (viewport CSS pixels) | {type:"type", text} | {type:"key", key} (Enter, Tab,
 * Backspace, Escape, arrows, PageUp/Down, Home, End, Delete, Control+A/C/V) |
 * {type:"scroll", dx, dy, x?, y?} | back | forward | reload.
 * Answers {url, title, loading, canGoBack, canGoForward, copied?}.
 */
export const POST = handler(
  { permission: "scan:run", sessionOnly: true, noRateLimit: true, schema },
  async ({ session, params, body }) => {
    const id = params.id ?? "";
    if (!SESSION_ID.test(id)) throw new NotFound("Browser session not found");
    // Typing sends one request per burst of keys, so this budget is wider than the API's.
    await enforce(`browser:act:${session.userId}`, 300, 60_000);
    const res = await callWorker(`/sessions/${id}/action`, { method: "POST", caller: session, body, timeoutMs: 25_000 });
    return workerJson(res);
  },
);
