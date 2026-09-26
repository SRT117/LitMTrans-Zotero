(function (global) {
  "use strict";

  const LitMTrans = global.LitMTrans = global.LitMTrans || {};
  const Agent = LitMTrans.Agent = LitMTrans.Agent || {};
  const C = Agent.Contracts;

  function fallbackAbortController() {
    const listeners = new Set();
    const signal = {
      aborted: false,
      reason: undefined,
      addEventListener(type, listener) {
        if (type !== "abort" || typeof listener !== "function") return;
        listeners.add(listener);
        if (this.aborted) {
          try { listener({ type: "abort" }); } catch (_) {}
        }
      },
      removeEventListener(type, listener) {
        if (type === "abort") listeners.delete(listener);
      }
    };
    return {
      signal,
      abort(reason = "操作已停止") {
        if (signal.aborted) return;
        signal.aborted = true;
        signal.reason = reason;
        const pending = [...listeners];
        listeners.clear();
        for (const listener of pending) {
          try { listener({ type: "abort" }); } catch (_) {}
        }
      }
    };
  }

  function abortController() {
    try { return new global.AbortController(); }
    catch (_) {
      try { return LitMTrans.Utils?.newAbortController?.() || fallbackAbortController(); }
      catch (_) { return fallbackAbortController(); }
    }
  }

  function publicJob(job) {
    if (!job) return null;
    return C.redact({
      id: job.id,
      kind: job.kind,
      status: job.status,
      progress: job.progress,
      phase: job.phase,
      message: job.message,
      input: job.input,
      result: job.result,
      error: job.error,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      updatedAt: job.updatedAt,
      completedAt: job.completedAt,
      parentJobID: job.parentJobID || "",
      children: Array.isArray(job.children) ? job.children : [],
      logs: Array.isArray(job.logs) ? job.logs.slice(-40) : []
    });
  }

  class AgentTaskManager {
    constructor(storage, options = {}) {
      this.storage = storage;
      this.root = PathUtils.join(storage.root, "agent");
      this.path = PathUtils.join(this.root, "jobs.json");
      this.jobs = new Map();
      this.active = new Map();
      this.runs = new Map();
      this.resolvers = new Map();
      this.listeners = new Set();
      this.maxHistory = Math.max(20, Number(options.maxHistory || 300));
      this.persistChain = Promise.resolve();
    }

    async init() {
      await this.storage.ensureDir(this.root);
      const rows = await this.storage.readJSON(this.path, []);
      for (const row of Array.isArray(rows) ? rows : []) {
        if (!row?.id || !row?.kind) continue;
        const job = {
          ...row,
          input: C.redact(row.input || {}),
          status: ["queued", "running", "waiting_remote", "finalizing"].includes(row.status) ? "interrupted" : String(row.status || "failed"),
          error: ["queued", "running", "waiting_remote", "finalizing"].includes(row.status)
            ? { code: "JOB_INTERRUPTED", message: "Zotero 或 LitMTrans 重启时任务被中断", recoverable: true, suggestedAction: "retry_job", details: null }
            : row.error || null,
          updatedAt: C.now()
        };
        this.jobs.set(String(job.id), job);
      }
      await this.persist();
    }

    on(listener) {
      if (typeof listener !== "function") return () => {};
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    }

    emit(job, event = {}) {
      const payload = { jobID: job.id, ...C.redact(event), job: publicJob(job) };
      for (const listener of this.listeners) {
        try { listener(payload); } catch (_) {}
      }
    }

    async persist() {
      const rows = [...this.jobs.values()]
        .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))
        .slice(0, this.maxHistory);
      this.persistChain = this.persistChain.catch(() => {}).then(async () => {
        await this.storage.ensureDir(this.root);
        await this.storage.writeJSON(this.path, rows.map(row => publicJob(row)));
      });
      return this.persistChain;
    }

    setResolver(kind, resolver) {
      if (typeof resolver === "function") this.resolvers.set(String(kind), resolver);
    }

    createJob(kind, input = {}, parentJobID = "") {
      const id = C.safeID(LitMTrans.Utils?.randomID?.("job") || `job-${Date.now()}`);
      const createdAt = C.now();
      return {
        id,
        kind: String(kind || "task"),
        status: "queued",
        progress: 0,
        phase: "queued",
        message: "任务已排队",
        input: C.redact(input || {}),
        result: null,
        error: null,
        createdAt,
        startedAt: "",
        updatedAt: createdAt,
        completedAt: "",
        parentJobID: String(parentJobID || ""),
        children: [],
        logs: []
      };
    }

    get(jobID) {
      return publicJob(this.jobs.get(String(jobID || "")) || null);
    }

    raw(jobID) {
      return this.jobs.get(String(jobID || "")) || null;
    }

    list(options = {}) {
      const status = String(options.status || "");
      const kind = String(options.kind || "");
      const parentJobID = String(options.parentJobID || "");
      const limit = Math.min(200, Math.max(1, Number(options.limit || 50)));
      return [...this.jobs.values()]
        .filter(job => !status || job.status === status)
        .filter(job => !kind || job.kind === kind)
        .filter(job => !parentJobID || job.parentJobID === parentJobID)
        .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))
        .slice(0, limit)
        .map(publicJob);
    }

    update(job, patch = {}, event = null) {
      Object.assign(job, patch, { updatedAt: C.now() });
      if (event) {
        const row = { at: job.updatedAt, ...C.redact(event) };
        job.logs = [...(Array.isArray(job.logs) ? job.logs : []), row].slice(-100);
        this.emit(job, event);
      }
      void this.persist();
      return publicJob(job);
    }

    async execute(job, runner) {
      if (job.status === "cancelled") return publicJob(job);
      const controller = abortController();
      this.active.set(job.id, controller);
      this.update(job, { status: "running", phase: "starting", startedAt: C.now(), message: "任务开始" }, { type: "job-started", message: "任务开始" });
      try {
        const result = await runner({
          signal: controller.signal,
          emit: event => {
            const type = String(event?.type || "progress");
            let status = job.status;
            if (type === "status" && ["queued", "running", "waiting_remote", "finalizing"].includes(String(event?.status || ""))) status = String(event.status);
            if (type === "waiting_remote") status = "waiting_remote";
            if (type === "finalizing") status = "finalizing";
            const progress = Number(event?.progress);
            this.update(job, {
              status,
              progress: Number.isFinite(progress) ? Math.max(0, Math.min(100, progress)) : job.progress,
              phase: String(event?.phase || job.phase || "running"),
              message: String(event?.message || job.message || "")
            }, event);
          }
        });
        this.update(job, {
          status: "completed",
          progress: 100,
          phase: "completed",
          message: "任务完成",
          result: C.redact(result),
          error: null,
          completedAt: C.now()
        }, { type: "job-completed", message: "任务完成", progress: 100 });
      }
      catch (error) {
        const cancelled = Boolean(controller.signal?.aborted);
        const normalized = C.asAgentError(error, cancelled ? "JOB_CANCELLED" : "JOB_FAILED");
        this.update(job, {
          status: cancelled ? "cancelled" : "failed",
          phase: cancelled ? "cancelled" : "failed",
          message: normalized.message,
          error: normalized.toJSON(),
          completedAt: C.now()
        }, { type: cancelled ? "job-cancelled" : "job-failed", message: normalized.message });
      }
      finally {
        this.active.delete(job.id);
        await this.persist();
      }
      return publicJob(job);
    }

    start(kind, input, runner, options = {}) {
      const job = this.createJob(kind, input, options.parentJobID);
      this.jobs.set(job.id, job);
      if (options.parentJobID) {
        const parent = this.raw(options.parentJobID);
        if (parent) parent.children = [...new Set([...(parent.children || []), job.id])];
      }
      if (typeof runner === "function") this.resolvers.set(job.kind, options.resolver || this.resolvers.get(job.kind) || (() => runner));
      void this.persist();
      const run = Promise.resolve().then(() => this.execute(job, runner));
      this.runs.set(job.id, run);
      void run.finally(() => this.runs.delete(job.id));
      return publicJob(job);
    }

    cancel(jobID) {
      const job = this.raw(jobID);
      if (!job) throw new C.AgentError("JOB_NOT_FOUND", `未找到任务 ${jobID}`, { recoverable: false });
      // 父 Job 取消时，连同已经排队或正在运行的子 Job 一起中止；否则
      // 批处理虽然对外显示已取消，后台 MinerU/翻译仍会继续占用配额。
      for (const childID of Array.isArray(job.children) ? job.children : []) {
        const child = this.raw(childID);
        if (child && !["completed", "failed", "cancelled", "interrupted"].includes(child.status)) {
          try { this.cancel(childID); } catch (_) {}
        }
      }
      const active = this.active.get(job.id);
      if (active) {
        active.abort("cancelled");
        this.update(job, { message: "正在取消任务" }, { type: "job-log", message: "正在取消任务" });
      }
      else if (["queued", "interrupted"].includes(job.status)) {
        this.update(job, { status: "cancelled", phase: "cancelled", message: "任务已取消", completedAt: C.now() }, { type: "job-cancelled", message: "任务已取消" });
      }
      return publicJob(job);
    }

    retry(jobID) {
      const old = this.raw(jobID);
      if (!old) throw new C.AgentError("JOB_NOT_FOUND", `未找到任务 ${jobID}`, { recoverable: false });
      const resolver = this.resolvers.get(old.kind);
      if (typeof resolver !== "function") throw new C.AgentError("JOB_RETRY_UNAVAILABLE", "该任务类型无法在当前会话中自动重试", { recoverable: true });
      const holder = { id: "" };
      const runner = resolver(old.input, old, () => holder.id);
      if (typeof runner !== "function") throw new C.AgentError("JOB_RETRY_UNAVAILABLE", "该任务的重试上下文已经失效", { recoverable: true });
      const next = this.start(old.kind, old.input, runner, { parentJobID: old.parentJobID });
      holder.id = next.id;
      return next;
    }

    async shutdown() {
      for (const controller of this.active.values()) {
        try { controller.abort("插件已停止"); } catch (_) {}
      }
      await Promise.all([...this.runs.values()].map(run => run.catch(() => null)));
      await this.persist();
      this.active.clear();
    }
  }

  Agent.AgentTaskManager = AgentTaskManager;
  Agent.publicJob = publicJob;
})(this);
