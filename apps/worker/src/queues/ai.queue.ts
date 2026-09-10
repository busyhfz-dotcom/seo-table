export const AI_QUEUE = 'seo-ai';

export function enqueueAIJob(payload: unknown){
  return { queue: AI_QUEUE, payload };
}
