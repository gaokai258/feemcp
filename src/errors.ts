import type { ToolError } from "./types.js";

export function makeError(
  error: string,
  opts: { code?: string; retryable?: boolean; suggested_action?: string } = {},
): ToolError {
  return {
    error,
    code: opts.code,
    retryable: opts.retryable,
    suggested_action: opts.suggested_action,
  };
}

export function isToolError(obj: unknown): obj is ToolError {
  return (
    typeof obj === "object" &&
    obj !== null &&
    "error" in obj &&
    typeof (obj as Record<string, unknown>).error === "string"
  );
}
