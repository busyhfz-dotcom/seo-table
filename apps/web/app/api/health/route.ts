export async function GET() {
  return Response.json({
    status: "ok",
    service: "seo-table-web",
    timestamp: new Date().toISOString()
  });
}
