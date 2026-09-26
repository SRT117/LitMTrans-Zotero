(function (global) {
  "use strict";

  const LitMTrans = global.LitMTrans = global.LitMTrans || {};
  const Agent = LitMTrans.Agent = LitMTrans.Agent || {};

  function notifierQueue() {
    try {
      const Queue = global.Zotero?.Notifier?.Queue;
      return typeof Queue === "function" ? new Queue() : null;
    }
    catch (_) { return null; }
  }

  class ZoteroWriteCoordinator {
    constructor(options = {}) {
      this.maxForegroundWaitMs = Math.max(0, Number(options.maxForegroundWaitMs ?? 250));
      this.logger = typeof options.logger === "function" ? options.logger : () => {};
      this.tail = Promise.resolve();
      this.notifierTail = Promise.resolve();
      this.pending = 0;
      this.pendingNotifiers = 0;
      this.lastError = null;
      this.lastNotifierError = null;
    }

    runSerializedWrite(label, write) {
      const name = String(label || "zotero-write");
      this.pending += 1;
      const run = async () => {
        try {
          return await write();
        }
        catch (error) {
          this.lastError = { label: name, message: String(error?.message || error), at: new Date().toISOString() };
          try { this.logger(`Zotero 写入失败（${name}）：${this.lastError.message}`); } catch (_) {}
          throw error;
        }
        finally {
          this.pending = Math.max(0, this.pending - 1);
        }
      };
      const operation = this.tail.then(run, run);
      this.tail = operation.catch(() => undefined);
      return operation;
    }

    enqueue(label, commit, options = {}) {
      const name = String(label || "zotero-write");
      const operation = this.runSerializedWrite(name, commit);
      if (options.wait === false) return Promise.resolve({ completed: false, queued: true, pending: this.pending });
      const waitMs = Math.max(0, Number(options.maxWaitMs ?? this.maxForegroundWaitMs));
      if (!waitMs) return operation;
      return Promise.race([
        operation.then(value => ({ completed: true, value, pending: Math.max(0, this.pending - 1) })),
        new Promise(resolve => setTimeout(() => resolve({ completed: false, queued: true, pending: this.pending }), waitMs))
      ]).then(result => {
        if (result && result.completed) return result.value;
        return undefined;
      });
    }

    async commitNotifierQueue(queue, label = "notifier") {
      if (!queue || typeof global.Zotero?.Notifier?.commit !== "function") {
        return { completed: true, pending: this.pendingNotifiers, status: "completed" };
      }
      const name = String(label || "notifier");
      const startedAt = Date.now();
      this.pendingNotifiers += 1;
      let commitError;
      const scheduled = this.notifierTail.then(async () => {
        try {
          await global.Zotero.Notifier.commit(queue);
        }
        catch (error) {
          commitError = error;
          this.lastNotifierError = { label: name, message: String(error?.message || error), at: new Date().toISOString() };
          try { this.logger(`Zotero Notifier 提交失败（${name}）：${this.lastNotifierError.message}`); } catch (_) {}
        }
      });
      const settled = scheduled.finally(() => {
        this.pendingNotifiers = Math.max(0, this.pendingNotifiers - 1);
      });
      this.notifierTail = settled.catch(() => undefined);
      let timer;
      const completed = await Promise.race([
        settled.then(() => true),
        new Promise(resolve => { timer = setTimeout(() => resolve(false), this.maxForegroundWaitMs); })
      ]);
      if (timer) clearTimeout(timer);
      return {
        completed: Boolean(completed),
        elapsedMs: Date.now() - startedAt,
        pending: this.pendingNotifiers,
        status: completed ? (commitError ? "failed" : "completed") : "pending",
        ...(commitError ? { error: String(commitError?.message || commitError) } : {})
      };
    }

    async saveEntity(entity, options = {}) {
      if (!entity || typeof entity.saveTx !== "function") return entity;
      const queue = notifierQueue();
      const saveOptions = queue ? { skipSelect: true, notifierQueue: queue } : undefined;
      await this.runSerializedWrite(options.label || "save", () => entity.saveTx(saveOptions));
      // 数据库事务必须完整等待；Notifier 观察者则只占用短暂前台预算，
      // 超时后继续在独立队列中运行，并由 shutdown/flush 收尾。
      if (queue) await this.commitNotifierQueue(queue, options.label || "save");
      return entity;
    }

    async flush(maxWaitMs = 5000) {
      const deadline = Date.now() + Math.max(0, Number(maxWaitMs) || 0);
      while ((this.pending > 0 || this.pendingNotifiers > 0) && Date.now() < deadline) {
        const remaining = Math.max(1, deadline - Date.now());
        const waits = [];
        if (this.pending > 0) waits.push(this.tail);
        if (this.pendingNotifiers > 0) waits.push(this.notifierTail);
        waits.push(new Promise(resolve => setTimeout(resolve, Math.min(remaining, 50))));
        await Promise.race(waits);
      }
      return {
        pending: this.pending,
        pendingNotifiers: this.pendingNotifiers,
        flushed: this.pending === 0 && this.pendingNotifiers === 0,
        lastError: this.lastError,
        lastNotifierError: this.lastNotifierError
      };
    }

    getPendingCount() { return this.pending; }
    getPendingNotifierCount() { return this.pendingNotifiers; }
  }

  let singleton = null;
  function getWriteCoordinator(options = {}) {
    if (!singleton) singleton = new ZoteroWriteCoordinator(options);
    return singleton;
  }

  Agent.ZoteroWriteCoordinator = ZoteroWriteCoordinator;
  Agent.getZoteroWriteCoordinator = getWriteCoordinator;
  Agent.flushZoteroWrites = maxWaitMs => singleton ? singleton.flush(maxWaitMs) : Promise.resolve({ pending: 0, flushed: true, lastError: null });
})(this);
