import { AppError } from "@seo/core";

/** The browser cannot run here (disabled, failed to launch, crashed, or shutting down). */
export class BrowserUnavailable extends AppError {
  constructor(message = "The browser is not available right now", details?: unknown) {
    super(503, "BROWSER_UNAVAILABLE", message, details);
  }
}

/** Every slot the limits allow is taken; the caller may retry once one frees. */
export class BrowserBusy extends AppError {
  constructor(reason: "capacity" | "org_limit" | "renders") {
    super(429, "BROWSER_BUSY", "All browser slots are in use; try again shortly", { reason });
  }
}
