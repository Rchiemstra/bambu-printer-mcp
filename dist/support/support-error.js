export class SupportToolError extends Error {
    constructor(code, message, options = {}) {
        super(message);
        this.name = "SupportToolError";
        this.code = code;
        this.retryable = options.retryable ?? false;
        this.details = options.details;
        if (options.cause !== undefined)
            this.cause = options.cause;
    }
}
export function throwIfCancelled(signal, deadlineMs) {
    if (signal?.aborted) {
        throw new SupportToolError("CANCELLED", "Support analysis was cancelled.");
    }
    if (deadlineMs !== undefined && Date.now() > deadlineMs) {
        throw new SupportToolError("TIMEOUT", "Support analysis exceeded its deadline.", { retryable: true });
    }
}
export function asSupportToolError(error) {
    if (error instanceof SupportToolError)
        return error;
    return new SupportToolError("SUPPORT_PROCESSING_FAILED", error instanceof Error ? error.message : String(error), { cause: error });
}
