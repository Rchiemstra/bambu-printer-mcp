export declare class SupportToolError extends Error {
    readonly code: string;
    readonly retryable: boolean;
    readonly details?: Record<string, unknown>;
    constructor(code: string, message: string, options?: {
        retryable?: boolean;
        details?: Record<string, unknown>;
        cause?: unknown;
    });
}
export declare function throwIfCancelled(signal?: AbortSignal, deadlineMs?: number): void;
export declare function asSupportToolError(error: unknown): SupportToolError;
