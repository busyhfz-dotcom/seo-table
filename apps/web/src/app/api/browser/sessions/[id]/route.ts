import { NotFound } from "@seo/core";
import { handler } from "../../../../../lib/route";
import { callWorker, SESSION_ID, workerJson } from "../../_lib/worker";

/** Close a browser session now rather than waiting for its idle timeout. */
export const DELETE = handler({ permission: "scan:run", sessionOnly: true }, async ({ session, params }) => {
  const id = params.id ?? "";
  if (!SESSION_ID.test(id)) throw new NotFound("Browser session not found");
  const res = await callWorker(`/sessions/${id}`, { method: "DELETE", caller: session, timeoutMs: 10_000 });
  return workerJson(res);
});
