namespace LitMTransPort {
  export interface AbortLikeSignal {
    readonly aborted: boolean;
    readonly reason?: unknown;
    addEventListener?(type: "abort", listener: () => void, options?: { once?: boolean }): void;
    removeEventListener?(type: "abort", listener: () => void): void;
  }
  export interface TaskProgress {
    stage: string;
    message: string;
    current: number;
    total: number;
    percent: number | null;
    detail: Record<string, unknown>;
  }
  export type ProgressCallback = (progress: TaskProgress) => void;


  export function throwIfAborted(signal?: AbortLikeSignal | null): void {
    if (signal?.aborted) {
      throw new CancelledError(typeof signal.reason === "string" ? signal.reason : "操作已停止");
    }
  }


  export async function cancellableSleep(ms: number, signal?: AbortLikeSignal | null): Promise<void> {
    throwIfAborted(signal);
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let abort: (() => void) | null = null;
      const timer = setTimeout(() => {
        settled = true;
        if (abort) signal?.removeEventListener?.("abort", abort);
        resolve();
      }, Math.max(0, Number(ms) || 0));
      if (!signal?.addEventListener) return;
      abort = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener?.("abort", abort!);
        reject(new CancelledError(typeof signal.reason === "string" ? signal.reason : "操作已停止"));
      };
      signal.addEventListener("abort", abort!, { once: true });
    });
    throwIfAborted(signal);
  }


  export function retryDelay(attempt: number, baseDelay = 1000, maxDelay = 20000, jitter = 0): number {
    const exponential = Math.min(Math.max(0, maxDelay), Math.max(0, baseDelay) * Math.pow(2, Math.max(0, attempt - 1)));
    const boundedJitter = Math.max(0, Math.min(1, jitter));
    return Math.round(exponential * (1 - boundedJitter / 2 + Math.random() * boundedJitter));
  }


  export async function runWithRetry<T>(operation: (attempt: number) => Promise<T>, options: {
    attempts?: number;
    signal?: AbortLikeSignal | null;
    shouldRetry?: (error: PortError, attempt: number) => boolean;
    onRetry?: (error: PortError, nextAttempt: number, attempts: number, delay: number) => void;
    baseDelay?: number;
    maxDelay?: number;
    jitter?: number;
  } = {}): Promise<T> {
    const attempts = Math.max(1, Math.trunc(options.attempts || 4));
    let last: PortError | null = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      throwIfAborted(options.signal);
      try {
        return await operation(attempt);
      }
      catch (error) {
        last = normalizePortError(error);
        if (last instanceof CancelledError) throw last;
        const retry = options.shouldRetry ? options.shouldRetry(last, attempt) : last.retryable;
        if (!retry || attempt >= attempts) throw last;
        const delay = retryDelay(attempt, options.baseDelay, options.maxDelay, options.jitter);
        options.onRetry?.(last, attempt + 1, attempts, delay);
        await cancellableSleep(delay, options.signal);
      }
    }
    throw last || new PortError("PARSE_FAILED", "任务失败");
  }


  export class TaskContext {
    readonly signal: AbortLikeSignal | null;
    readonly emit: ProgressCallback | null;
    readonly taskID: string;
    readonly startedAt: number;
    private cleanupStack: Array<() => void | Promise<void>> = [];
    constructor(taskID: string, signal: AbortLikeSignal | null = null, emit: ProgressCallback | null = null) {
      this.taskID = String(taskID || "task");
      this.signal = signal;
      this.emit = emit;
      this.startedAt = Date.now();
    }
    check(): void { throwIfAborted(this.signal); }
    progress(stage: string, message: string, current = 0, total = 0, detail: Record<string, unknown> = {}): void {
      this.check();
      this.emit?.({
        stage, message, current, total,
        percent: total > 0 ? Math.max(0, Math.min(100, current / total * 100)) : null,
        detail: { ...detail }
      });
    }
    defer(cleanup: () => void | Promise<void>): void { this.cleanupStack.push(cleanup); }
    async cleanup(): Promise<PortError[]> {
      const errors: PortError[] = [];
      for (const cleanup of this.cleanupStack.splice(0).reverse()) {
        try { await cleanup(); }
        catch (error) { errors.push(normalizePortError(error, "PUBLISH_FAILED")); }
      }
      return errors;
    }
  }

  export async function runTask<T>(context: TaskContext, operation: (context: TaskContext) => Promise<T>): Promise<T> {
    try {
      context.check();
      return await operation(context);
    }
    finally {
      await context.cleanup();
    }
  }
}
