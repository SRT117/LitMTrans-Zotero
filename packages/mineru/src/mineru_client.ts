namespace LitMTransPort {
  export interface MinerUOptions { modelVersion: string; isOCR: boolean; enableTable: boolean; enableFormula: boolean; }
  export interface MinerUTask { batchID: string; status: string; resultURL: string; error: string; progress: number; }
  export interface MinerUAdapter { apiBase: string; token: string; http: HttpClient; }
  export function short_upload_filename(path: string): string {
    const ext = inputExtension(path); const clean = safe_document_stem(normalizeOriginalPathHint(path).replace(/\.[^.]+$/, ""), "document", 48); return `${clean}-${shortHash(path)}${ext}`;
  }
  export function temporary_mineru_upload_file(path: string): { originalPath: string; uploadName: string } { return { originalPath: path, uploadName: short_upload_filename(path) }; }
  export function mineruIsSupportedInputFile(path: string): boolean { return is_supported_input_file(path) && !is_direct_text_input_file(path); }
  export function buildMinerUSubmitPayload(filename: string, options: MinerUOptions): Record<string, unknown> {
    return { files: [{ name: filename, data_id: shortHash(filename) }], model_version: options.modelVersion || "vlm", is_ocr: Boolean(options.isOCR), enable_table: Boolean(options.enableTable), enable_formula: Boolean(options.enableFormula) };
  }
  export function normalizeMinerUTask(value: unknown): MinerUTask {
    const data = value && typeof value === "object" ? value as Record<string, unknown> : {};
    const nested = (data.data && typeof data.data === "object" ? data.data : data) as Record<string, unknown>;
    const item = Array.isArray(nested.extract_result) ? (nested.extract_result[0] as Record<string, unknown> || {}) : nested;
    return {
      batchID: String(nested.batch_id || nested.batchID || item.batch_id || ""),
      status: String(item.state || item.status || nested.state || nested.status || "").toLowerCase(),
      resultURL: String(item.full_zip_url || item.result_url || item.url || ""),
      error: String(item.err_msg || item.error || nested.err_msg || nested.error || ""),
      progress: Math.max(0, Math.min(100, Number(item.progress || nested.progress || 0)))
    };
  }
  export async function submitMinerUTask(adapter: MinerUAdapter, filename: string, options: MinerUOptions, signal: AbortLikeSignal | null = null): Promise<Record<string, unknown>> {
    throwIfAborted(signal);
    return adapter.http.requestJSON("POST", `${adapter.apiBase.replace(/\/$/, "")}/file-urls/batch`, { headers: { Authorization: `Bearer ${adapter.token}` }, json: buildMinerUSubmitPayload(filename, options), signal });
  }
  export async function pollMinerUTask(adapter: MinerUAdapter, batchID: string, options: { attempts?: number; intervalMs?: number; signal?: AbortLikeSignal | null; onProgress?: ProgressCallback } = {}): Promise<MinerUTask> {
    const attempts = Math.max(1, Number(options.attempts || 180));
    for (let attempt = 1; attempt <= attempts; attempt++) {
      throwIfAborted(options.signal);
      const raw = await adapter.http.requestJSON<Record<string, unknown>>("GET", `${adapter.apiBase.replace(/\/$/, "")}/extract-results/batch/${encodeURIComponent(batchID)}`, { headers: { Authorization: `Bearer ${adapter.token}` }, signal: options.signal });
      const task = normalizeMinerUTask(raw);
      options.onProgress?.({ stage: "mineru-poll", message: `MinerU: ${task.status || "processing"}`, current: attempt, total: attempts, percent: task.progress || null, detail: { batchID } });
      if (["done", "success", "completed"].includes(task.status) && task.resultURL) return task;
      if (["failed", "error", "cancelled"].includes(task.status)) throw new PortError("PARSE_FAILED", task.error || `文献解析失败：${task.status}`);
      await cancellableSleep(Number(options.intervalMs || 2000), options.signal);
    }
    throw new PortError("PARSE_FAILED", "文献解析服务响应超时，请稍后重试", { retryable: true, detail: { batchID } });
  }
  export function saveMineruToken(store: SecretStore, value: string): void { saveSecret(store, "mineru", "official", value); }
  export function loadMineruToken(store: SecretStore): string { return loadSecret(store, "mineru", "official"); }

  export interface MinerUDocumentToolAdapter {
    isConfigured(): boolean;
    saveKey(token: string): string;
    isSupportedInputFile(path: string): boolean;
    createOutputDirectory(documentID: string): string;
    parse(inputPath: string, outputDirectory: string, context: TaskContext): Promise<NormalizedDocument>;
    latestTranslationPath(documentID: string): string | null;
    findStoredOriginal(documentID: string): string | null;
    createReaderWindow(mode: "stream" | "layout"): ReaderModeState;
  }

  export function buildMineruDocumentToolAdapter(adapter: MinerUDocumentToolAdapter): MinerUDocumentToolAdapter {
    const required: Array<keyof MinerUDocumentToolAdapter> = [
      "isConfigured", "saveKey", "isSupportedInputFile", "createOutputDirectory", "parse",
      "latestTranslationPath", "findStoredOriginal", "createReaderWindow"
    ];
    for (const key of required) {
      if (typeof adapter?.[key] !== "function") throw new PortError("HOST_ADAPTER", `MinerU文档工具适配器缺少 ${String(key)} 方法`);
    }
    return Object.freeze({
      isConfigured: () => Boolean(adapter.isConfigured()),
      saveKey: (token: string) => adapter.saveKey(String(token || "").trim()),
      isSupportedInputFile: (path: string) => Boolean(adapter.isSupportedInputFile(String(path || ""))),
      createOutputDirectory: (documentID: string) => adapter.createOutputDirectory(String(documentID || "")),
      parse: (inputPath: string, outputDirectory: string, context: TaskContext) => {
        context.check();
        return adapter.parse(String(inputPath || ""), String(outputDirectory || ""), context);
      },
      latestTranslationPath: (documentID: string) => adapter.latestTranslationPath(String(documentID || "")),
      findStoredOriginal: (documentID: string) => adapter.findStoredOriginal(String(documentID || "")),
      createReaderWindow: (mode: "stream" | "layout") => Object.freeze({ ...adapter.createReaderWindow(mode) })
    });
  }

  export interface MinerUParseWorker {
    readonly context: TaskContext;
    run(): Promise<NormalizedDocument>;
    requestStop(reason?: string): void;
    isCancelled(): boolean;
  }

  export function createParseWorker(
    adapter: MinerUDocumentToolAdapter,
    inputPath: string,
    outputDirectory: string,
    onProgress: ProgressCallback | null = null
  ): MinerUParseWorker {
    const controller = new AbortController();
    const context = new TaskContext(`mineru-${shortHash(inputPath)}`, controller.signal, onProgress);
    let running: Promise<NormalizedDocument> | null = null;
    return Object.freeze({
      context,
      run(): Promise<NormalizedDocument> {
        if (!running) running = runTask(context, current => adapter.parse(inputPath, outputDirectory, current));
        return running;
      },
      requestStop(reason = "已取消解析"): void { if (!controller.signal.aborted) controller.abort(reason); },
      isCancelled(): boolean { return controller.signal.aborted; }
    });
  }
}
