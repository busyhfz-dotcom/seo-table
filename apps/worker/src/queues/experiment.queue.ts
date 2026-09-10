export const EXPERIMENT_QUEUE = 'seo-experiment';

export function enqueueExperimentJob(payload: unknown){
  return { queue: EXPERIMENT_QUEUE, payload };
}
