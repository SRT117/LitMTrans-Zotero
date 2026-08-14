namespace LitMTransPort {
  export type PortErrorCode =
    | "CANCELLED" | "HTTP" | "INVALID_INPUT" | "INVALID_ZIP" | "CACHE_CORRUPT"
    | "STALE_TRANSLATION" | "PARSE_FAILED" | "TRANSLATION_FAILED" | "PUBLISH_FAILED"
    | "PROVIDER_CONFIGURATION" | "MODEL_PROTOCOL" | "HOST_ADAPTER";


  export class PortError extends Error {
    readonly code: PortErrorCode;
    readonly retryable: boolean;
    readonly detail: Record<string, unknown>;
    readonly causeValue: unknown;
    constructor(code: PortErrorCode, message: string, options: {
      retryable?: boolean; detail?: Record<string, unknown>; cause?: unknown;
    } = {}) {
      super(message);
      this.name = "PortError";
      this.code = code;
      this.retryable = Boolean(options.retryable);
      this.detail = { ...(options.detail || {}) };
      this.causeValue = options.cause;
    }
  }


  export class CancelledError extends PortError {
    readonly cancelled = true;
    constructor(message = "操作已停止", detail: Record<string, unknown> = {}) {
      super("CANCELLED", message, { retryable: false, detail });
      this.name = "CancelledError";
    }
  }


  export function normalizePortError(error: unknown, fallback: PortErrorCode = "PARSE_FAILED"): PortError {
    if (error instanceof PortError) return error;
    const value = error as { name?: string; message?: string; status?: number; cancelled?: boolean } | null;
    if (value?.cancelled || value?.name === "AbortError" || value?.name === "CancelledError") {
      return new CancelledError(value?.message || "操作已停止");
    }
    const status = Number(value?.status || 0);
    if (status) {
      return new PortError("HTTP", value?.message || `HTTP ${status}`, {
        retryable: status === 408 || status === 429 || status >= 500,
        detail: { status }, cause: error
      });
    }
    return new PortError(fallback, value?.message || String(error || "未知错误"), { cause: error });
  }


  export function serializePortError(error: unknown): Record<string, unknown> {
    const normalized = normalizePortError(error);
    return {
      name: normalized.name,
      code: normalized.code,
      message: normalized.message,
      retryable: normalized.retryable,
      cancelled: normalized instanceof CancelledError,
      detail: { ...normalized.detail }
    };
  }
}
