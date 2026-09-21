import { NextResponse } from "next/server";
import { health } from "../../../lib/queries";

export const dynamic = "force-dynamic";

/**
 * Readiness: the process can serve traffic. Postgres and Redis are both
 * required, so this is what a load balancer should gate on — not /health.
 */
export async function GET() {
  const snapshot = await health();
  const ok = snapshot.database && snapshot.redis;
  return NextResponse.json(
    { status: ok ? "ready" : "not_ready", checks: snapshot },
    { status: ok ? 200 : 503 },
  );
}
