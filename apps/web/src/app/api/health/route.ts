import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** Liveness: the process is up. Deliberately touches nothing else. */
export function GET() {
  return NextResponse.json({
    status: "ok",
    service: "web",
    version: process.env.APP_VERSION ?? "0.4.0",
    uptimeSeconds: Math.round(process.uptime()),
  });
}
