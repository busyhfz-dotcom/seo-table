export type ActionType =
  | "META_TITLE"
  | "META_DESCRIPTION"
  | "CANONICAL"
  | "SCHEMA";

export interface SeoAction {
  type: ActionType;
  targetUrl: string;
  payload: Record<string, unknown>;
}

export interface ExecutionResult {
  success: boolean;
  actionId: string;
  message: string;
}
