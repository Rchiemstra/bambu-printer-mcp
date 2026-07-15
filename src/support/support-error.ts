export class SupportToolError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    options: { retryable?: boolean; details?: Record<string, unknown>; cause?: unknown } = {}
  ) {
    super(message);
    this.name = "SupportToolError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
    if (options.cause !== undefined) (this as Error & { cause?: unknown }).cause = options.cause;
  }
}

export function throwIfCancelled(signal?: AbortSignal, deadlineMs?: number): void {
  if (signal?.aborted) {
    throw new SupportToolError("CANCELLED", "Support analysis was cancelled.");
  }
  if (deadlineMs !== undefined && Date.now() > deadlineMs) {
    throw new SupportToolError("TIMEOUT", "Support analysis exceeded its deadline.", { retryable: true });
  }
}

export function asSupportToolError(error: unknown): SupportToolError {
  if (error instanceof SupportToolError) return error;
  return new SupportToolError(
    "SUPPORT_PROCESSING_FAILED",
    error instanceof Error ? error.message : String(error),
    { cause: error }
  );
}
