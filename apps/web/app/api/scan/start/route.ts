export async function POST(){
  return Response.json({
    status:'queued',
    message:'SEO scan job created'
  });
}
