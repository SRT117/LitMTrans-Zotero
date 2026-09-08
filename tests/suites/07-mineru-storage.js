"use strict";

module.exports = function createSuite(env) {
  const {
    assert, fs, path, root, prefValues, context, zlib, nodeCrypto, vm,
    crc32, zipU16, zipU32, zipU64, oneEntryZip, oneEntryZip64,
    MemoryStorage, withResolvedChatModel,
    U, M, H, LLMService, LLMInternals,
    TranslationService, TranslationInternals,
    WebMachineTranslationService, WebMachineTranslation,
    EdgeLocalTranslation, LayoutTranslationService, LayoutHelpers,
    MinerUService, MinerUInternals, Mindmap, MindmapV2, Flowchart,
    ChatService, ChatInternals, ControllerInternals, DocumentPipeline
  } = env;

function testMinerUImageAssetValidation() {
  assert.deepEqual(
    MinerUInternals.localMarkdownImageTargets(
      "![figure](images/plot.jpg)\n![again](<images/plot.jpg>)\n![inline](data:image/png;base64,AA==)\n![remote](https://example.com/a.png)"
    ),
    ["images/plot.jpg"],
    "only MinerU-relative image targets require a packaged local asset"
  );
  assert.equal(MinerUInternals.extensionFromTarget("https://example.com/figure.final.PNG?download=1#page=2"), ".png");
  assert.equal(MinerUInternals.extensionFromTarget("images/figure%20one.jpg"), ".jpg");
}

async function testMinerUAutomaticPDFSplit() {
  assert.deepEqual(
    JSON.parse(JSON.stringify(MinerUInternals.planMinerUPageRanges(400))),
    [{ start: 0, end: 200, pageCount: 200 }, { start: 200, end: 400, pageCount: 200 }],
    "a boundary search must not create an avoidable extra upload"
  );
  const pageTexts = Array.from({ length: 401 }, (_, index) => `continued page ${index + 1},`);
  pageTexts[189] = "End of a complete section.";
  pageTexts[190] = "2 Methods";
  const semantic = MinerUInternals.planMinerUPageRanges(401, pageTexts);
  assert.equal(semantic.length, 3);
  assert.equal(semantic[0].end, 190, "a nearby semantic boundary should be preferred when part count stays constant");
  assert(semantic.every(part => part.pageCount <= 200));

  const source = await context.PDFLib.PDFDocument.create();
  for (let index = 0; index < 401; index++) source.addPage();
  const storage = new MemoryStorage();
  storage.stat = async () => { throw new Error("联网翻译不得读取参考文件"); };
  const sourcePath = "/mem/source.pdf";
  await storage.writeBytes(sourcePath, await source.save());
  const service = new MinerUService(storage, { getMinerUToken: () => "test" });
  const parts = await service.prepareUploadParts(sourcePath, "/mem/staging");
  assert.deepEqual(parts.map(part => part.pageCount), [200, 200, 1]);
  const toPDFRealmBytes = vm.runInContext("(value) => Uint8Array.from(value)", context);
  for (const part of parts) {
    const pdf = await context.PDFLib.PDFDocument.load(
      toPDFRealmBytes(await storage.readBytes(part.filePath))
    );
    assert.equal(pdf.getPageCount(), part.pageCount, "every generated upload part must preserve its planned pages");
  }

  const originalLoad = context.PDFLib.PDFDocument.load;
  const loadOptions = [];
  try {
    context.PDFLib.PDFDocument.load = async (_bytes, options) => {
      loadOptions.push(options);
      return { isEncrypted: true, getPageCount: () => 3 };
    };
    const encryptedOriginal = await service.prepareUploadParts(sourcePath, "/mem/encrypted");
    assert.deepEqual(
      JSON.parse(JSON.stringify(encryptedOriginal)),
      [{ filePath: sourcePath, start: 0, end: 3, pageCount: 3, temporary: false }],
      "a passwordless permissions-encrypted PDF under the limit must upload unchanged"
    );
    assert.equal(loadOptions.at(-1).ignoreEncryption, true, "page counting must accept PDF permission encryption");

    context.PDFLib.PDFDocument.load = async () => ({ isEncrypted: true, getPageCount: () => 201 });
    await assert.rejects(
      () => service.prepareUploadParts(sourcePath, "/mem/encrypted-long"),
      /无法安全拆分此类文件/
    );
  }
  finally {
    context.PDFLib.PDFDocument.load = originalLoad;
  }

  const rebased = MinerUInternals.rebaseMinerUPayload(
    { page_idx: 0, blocks: [{ page_index: 2, image_path: "images/a.png" }] },
    200,
    { "images/a.png": "assets/p002-a.png" }
  );
  assert.equal(rebased.page_idx, 200);
  assert.equal(rebased.blocks[0].page_index, 202);
  assert.equal(rebased.blocks[0].image_path, "assets/p002-a.png");
}

async function testLegacyStorageMigration() {
  const originalIOUtils = context.IOUtils;
  const existing = new Set(["/profile/ai-literature-translator"]);
  const moves = [];
  context.IOUtils = {
    async exists(file) { return existing.has(file); },
    async move(source, destination) {
      moves.push([source, destination]);
      existing.delete(source);
      existing.add(destination);
    }
  };
  try {
    const storage = new context.LitMTrans.Storage();
    await storage.migrateLegacyRoot();
    assert.deepEqual(
      moves,
      [["/profile/ai-literature-translator", "/profile/litmtrans"]],
      "an existing cache root must move to the LitMTrans directory before use"
    );
  }
  finally {
    context.IOUtils = originalIOUtils;
  }
}

function testLegacySecretMigration() {
  const originalLogins = context.Services.logins;
  context.Services.logins = {
    findLogins(origin, _formActionOrigin, realm) {
      if (origin === "chrome://ai-literature-translator" && realm === "AI Literature Translator") {
        return [{ username: "mineru", password: "legacy-token" }];
      }
      return [];
    }
  };
  try {
    const secrets = new context.LitMTrans.Secrets();
    let migrated = null;
    secrets.set = (name, value) => {
      migrated = { name, value };
      return true;
    };
    assert.equal(secrets.get("mineru"), "legacy-token");
    assert.deepEqual(migrated, { name: "mineru", value: "legacy-token" });
  }
  finally {
    context.Services.logins = originalLogins;
  }
}

function testPortableMinerUZipFallback() {
  const archive = MinerUInternals.readPortableZip(oneEntryZip("nested/model.json", '{"stable":true}'));
  const decoded = MinerUInternals.readPortableZipEntry(archive, "nested/model.json");
  assert.equal(Buffer.from(decoded).toString("utf8"), '{"stable":true}', "portable ZIP fallback must decode raw-DEFLATE entries");
  const zip64 = MinerUInternals.readPortableZip(oneEntryZip64("nested/zip64.json", '{"zip64":true}'));
  const decodedZip64 = MinerUInternals.readPortableZipEntry(zip64, "nested/zip64.json");
  assert.equal(Buffer.from(decodedZip64).toString("utf8"), '{"zip64":true}', "portable ZIP fallback must decode ZIP64 entries");
}

async function testDeletedZoteroItemsClearDocumentCaches() {
  const storage = {
    documentsRoot: "/profile/litmtrans/documents",
    async list() { return ["/profile/litmtrans/documents/1-ATTACH", "/profile/litmtrans/documents/1-KEEP"]; },
    async readJSON(file, fallback) {
      const records = {
        "/profile/litmtrans/documents/1-ATTACH/document.json": { itemID: 41, parentItemID: 40 },
        "/profile/litmtrans/documents/1-KEEP/document.json": { itemID: 51, parentItemID: 50 }
      };
      return records[file] || fallback;
    },
    async remove(directory, recursive) {
      assert.equal(recursive, true, "deleted document cache must be removed recursively");
      removed.push(directory);
    }
  };
  const removed = [];
  const cleared = await context.LitMTrans.Storage.prototype.clearDocumentsForDeletedItemIDs.call(storage, [40]);
  assert.deepEqual(cleared, ["1-ATTACH"], "deleting a parent item must remove its attachment cache");
  assert.deepEqual(removed, ["/profile/litmtrans/documents/1-ATTACH"]);

  const controller = context.LitMTrans.createController({ id: "litmtrans@local", version: "1.0.0", rootURI: "file:///plugin/" });
  const originalNotifier = context.Zotero.Notifier;
  const registrations = [];
  const stopped = [];
  context.Zotero.Notifier = {
    registerObserver(observer, types, id) { registrations.push({ observer, types, id }); return 73; },
    unregisterObserver(id) { registrations.push({ unregistered: id }); }
  };
  controller.storage = { clearDocumentsForDeletedItemIDs: async ids => { stopped.push(`cleared:${ids.join(",")}`); return ["1-ATTACH"]; } };
  controller.stopOperations = tabID => stopped.push(`stopped:${tabID}`);
  controller.cleanupTab = tabID => stopped.push(`closed:${tabID}`);
  try {
    assert(controller.registerItemDeletionObserver(), "the controller must register an item notifier");
    registrations[0].observer.notify("trash", "item", [41]);
    await Promise.resolve();
    assert.deepEqual(stopped, ["stopped:litmtrans-41", "closed:litmtrans-41", "cleared:41"], "moving an item to the Zotero trash must clear its cache immediately");
    assert.equal(controller.itemNotifierID, 73, "the notifier registration ID must be retained for shutdown cleanup");
  }
  finally {
    context.Zotero.Notifier = originalNotifier;
  }
}

  return {
    testMinerUImageAssetValidation,
    testMinerUAutomaticPDFSplit,
    testLegacyStorageMigration,
    testLegacySecretMigration,
    testPortableMinerUZipFallback,
    testDeletedZoteroItemsClearDocumentCaches,
  };
};
