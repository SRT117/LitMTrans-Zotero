namespace LitMTransPort {
  export interface PublishFile { temporaryPath: string; destinationPath: string; rollbackPath: string; }
  export interface AtomicPublishPlan { transactionID: string; files: PublishFile[]; }


  export function createAtomicPublishPlan(files: Array<{ temporaryPath: string; destinationPath: string }>, transactionID = `publish-${Date.now()}`): AtomicPublishPlan {
    const seen = new Set<string>();
    const normalized: PublishFile[] = [];
    for (const file of files) {
      const temporaryPath = String(file.temporaryPath || "");
      const destinationPath = String(file.destinationPath || "");
      if (!temporaryPath || !destinationPath) throw new PortError("PUBLISH_FAILED", "发布路径不能为空");
      if (seen.has(destinationPath)) throw new PortError("PUBLISH_FAILED", `同一事务重复发布目标: ${destinationPath}`);
      seen.add(destinationPath);
      normalized.push({ temporaryPath, destinationPath, rollbackPath: `${destinationPath}.rollback-${safe_document_stem(transactionID, "tx", 48)}` });
    }
    return { transactionID, files: normalized };
  }

  export async function atomicPublish(store: FileStore, plan: AtomicPublishPlan): Promise<void> {
    const movedToRollback: PublishFile[] = [];
    const published: PublishFile[] = [];
    try {
      for (const file of plan.files) {
        if (!await store.exists(file.temporaryPath)) throw new PortError("PUBLISH_FAILED", `临时结果不存在: ${file.temporaryPath}`);
      }
      for (const file of plan.files) {
        if (await store.exists(file.destinationPath)) {
          await store.remove(file.rollbackPath, true);
          await store.move(file.destinationPath, file.rollbackPath);
          movedToRollback.push(file);
        }
      }
      for (const file of plan.files) {
        await store.move(file.temporaryPath, file.destinationPath);
        published.push(file);
      }
      for (const file of movedToRollback) await store.remove(file.rollbackPath, true);
    }
    catch (error) {
      const rollbackErrors: string[] = [];
      for (const file of published.reverse()) {
        try { await store.remove(file.destinationPath, true); } catch (rollbackError) { rollbackErrors.push(String(rollbackError)); }
      }
      for (const file of movedToRollback.reverse()) {
        try {
          if (await store.exists(file.rollbackPath)) await store.move(file.rollbackPath, file.destinationPath);
        }
        catch (rollbackError) { rollbackErrors.push(String(rollbackError)); }
      }
      throw new PortError("PUBLISH_FAILED", "结果原子发布失败，已尝试恢复上一版", {
        detail: { transactionID: plan.transactionID, rollbackErrors }, cause: error
      });
    }
  }
}
