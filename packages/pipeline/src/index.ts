/**
 * The pipeline: the stages that turn a queued run into stored results, and the
 * stages that turn an approved proposal into writes on a live site.
 *
 * It lives in its own package because both the worker (which runs the jobs) and
 * the web app (which serves rollback, a request a person makes and waits for)
 * need it.
 */
export { analyze, markRunFailed, type AnalyzeOutcome } from "./analyze.js";
export { execute, rollback, type ExecuteInput, type ExecuteOutcome } from "./execute.js";
export { runAgent, type AgentReport } from "./agent.js";
