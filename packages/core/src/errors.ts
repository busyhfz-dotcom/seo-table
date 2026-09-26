/**
 * Typed application errors. Each carries an HTTP status and a stable machine
 * code, so API responses and tests never depend on message text.
 */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
  toJSON() {
    return { error: { code: this.code, message: this.message, details: this.details } };
  }
}

export class BadRequest extends AppError {
  constructor(message = "Invalid request", details?: unknown) {
    super(400, "BAD_REQUEST", message, details);
  }
}
/** The target URL resolves to an address the crawler and connectors must not reach. */
export class BlockedAddress extends AppError {
  constructor(message = "That address is not reachable from this service", details?: unknown) {
    super(400, "BLOCKED_ADDRESS", message, details);
  }
}
export class Unauthorized extends AppError {
  constructor(message = "Authentication required") {
    super(401, "UNAUTHORIZED", message);
  }
}
export class Forbidden extends AppError {
  constructor(message = "You do not have permission to do that", details?: unknown) {
    super(403, "FORBIDDEN", message, details);
  }
}
export class NotFound extends AppError {
  constructor(message = "Not found") {
    super(404, "NOT_FOUND", message);
  }
}
export class Conflict extends AppError {
  constructor(message = "Conflicting state", details?: unknown) {
    super(409, "CONFLICT", message, details);
  }
}
/** A Conflict with its own code, so the UI can say "a scan is already running". */
export class ScanAlreadyRunning extends AppError {
  constructor(runId?: string) {
    super(409, "SCAN_ACTIVE", "A scan is already active for this project", { activeRunId: runId });
  }
}
export class RateLimited extends AppError {
  constructor(retryAfterSeconds: number) {
    super(429, "RATE_LIMITED", "Too many requests", { retryAfterSeconds });
  }
}
export class ApprovalRequired extends Forbidden {
  constructor(action: string) {
    super(`${action} can never run without human approval`, { action, requiresApproval: true });
  }
}
export class PolicyViolation extends AppError {
  constructor(message: string, details?: unknown) {
    super(422, "POLICY_VIOLATION", message, details);
  }
}
export class UpstreamError extends AppError {
  constructor(message: string, details?: unknown) {
    super(502, "UPSTREAM_ERROR", message, details);
  }
}
export class NotConnected extends AppError {
  constructor(kind: string) {
    super(409, "CONNECTOR_NOT_CONNECTED", `${kind} is not connected`, { kind });
  }
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}

export function errorToResponse(e: unknown): { status: number; body: unknown } {
  if (isAppError(e)) return { status: e.status, body: e.toJSON() };
  return {
    status: 500,
    body: { error: { code: "INTERNAL", message: "Something went wrong on our side" } },
  };
}
