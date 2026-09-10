export async function crawlWorker(job: unknown){
  return {
    status:'processed',
    job
  };
}
