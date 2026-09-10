export const REPORT_QUEUE = 'seo-report';

export function enqueueReportJob(payload: unknown){
  return { queue: REPORT_QUEUE, payload };
}
