"use strict";
var LitMTransPort;
(function (LitMTransPort) {
    class PortError extends Error {
        constructor(code, message, options = {}) {
            super(message);
            this.name = "PortError";
            this.code = code;
            this.retryable = Boolean(options.retryable);
            this.detail = { ...(options.detail || {}) };
            this.causeValue = options.cause;
        }
    }
    LitMTransPort.PortError = PortError;
    class CancelledError extends PortError {
        constructor(message = "操作已停止", detail = {}) {
            super("CANCELLED", message, { retryable: false, detail });
            this.cancelled = true;
            this.name = "CancelledError";
        }
    }
    LitMTransPort.CancelledError = CancelledError;
    function normalizePortError(error, fallback = "PARSE_FAILED") {
        if (error instanceof PortError)
            return error;
        const value = error;
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
    LitMTransPort.normalizePortError = normalizePortError;
    function serializePortError(error) {
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
    LitMTransPort.serializePortError = serializePortError;
})(LitMTransPort || (LitMTransPort = {}));
var LitMTransPort;
(function (LitMTransPort) {
    function throwIfAborted(signal) {
        if (signal?.aborted) {
            throw new LitMTransPort.CancelledError(typeof signal.reason === "string" ? signal.reason : "操作已停止");
        }
    }
    LitMTransPort.throwIfAborted = throwIfAborted;
    async function cancellableSleep(ms, signal) {
        throwIfAborted(signal);
        await new Promise((resolve, reject) => {
            const timer = setTimeout(resolve, Math.max(0, Number(ms) || 0));
            if (!signal?.addEventListener)
                return;
            const abort = () => {
                clearTimeout(timer);
                reject(new LitMTransPort.CancelledError(typeof signal.reason === "string" ? signal.reason : "操作已停止"));
            };
            signal.addEventListener("abort", abort, { once: true });
        });
        throwIfAborted(signal);
    }
    LitMTransPort.cancellableSleep = cancellableSleep;
    function retryDelay(attempt, baseDelay = 1000, maxDelay = 20000, jitter = 0) {
        const exponential = Math.min(Math.max(0, maxDelay), Math.max(0, baseDelay) * Math.pow(2, Math.max(0, attempt - 1)));
        const boundedJitter = Math.max(0, Math.min(1, jitter));
        return Math.round(exponential * (1 - boundedJitter / 2 + Math.random() * boundedJitter));
    }
    LitMTransPort.retryDelay = retryDelay;
    async function runWithRetry(operation, options = {}) {
        const attempts = Math.max(1, Math.trunc(options.attempts || 4));
        let last = null;
        for (let attempt = 1; attempt <= attempts; attempt++) {
            throwIfAborted(options.signal);
            try {
                return await operation(attempt);
            }
            catch (error) {
                last = LitMTransPort.normalizePortError(error);
                if (last instanceof LitMTransPort.CancelledError)
                    throw last;
                const retry = options.shouldRetry ? options.shouldRetry(last, attempt) : last.retryable;
                if (!retry || attempt >= attempts)
                    throw last;
                const delay = retryDelay(attempt, options.baseDelay, options.maxDelay, options.jitter);
                options.onRetry?.(last, attempt + 1, attempts, delay);
                await cancellableSleep(delay, options.signal);
            }
        }
        throw last || new LitMTransPort.PortError("PARSE_FAILED", "任务失败");
    }
    LitMTransPort.runWithRetry = runWithRetry;
    class TaskContext {
        constructor(taskID, signal = null, emit = null) {
            this.cleanupStack = [];
            this.taskID = String(taskID || "task");
            this.signal = signal;
            this.emit = emit;
            this.startedAt = Date.now();
        }
        check() { throwIfAborted(this.signal); }
        progress(stage, message, current = 0, total = 0, detail = {}) {
            this.check();
            this.emit?.({
                stage, message, current, total,
                percent: total > 0 ? Math.max(0, Math.min(100, current / total * 100)) : null,
                detail: { ...detail }
            });
        }
        defer(cleanup) { this.cleanupStack.push(cleanup); }
        async cleanup() {
            const errors = [];
            for (const cleanup of this.cleanupStack.splice(0).reverse()) {
                try {
                    await cleanup();
                }
                catch (error) {
                    errors.push(LitMTransPort.normalizePortError(error, "PUBLISH_FAILED"));
                }
            }
            return errors;
        }
    }
    LitMTransPort.TaskContext = TaskContext;
    async function runTask(context, operation) {
        try {
            context.check();
            return await operation(context);
        }
        finally {
            await context.cleanup();
        }
    }
    LitMTransPort.runTask = runTask;
})(LitMTransPort || (LitMTransPort = {}));
var LitMTransPort;
(function (LitMTransPort) {
    LitMTransPort.SUPPORTED_INPUT_EXTENSIONS = Object.freeze([
        ".pdf", ".png", ".jpg", ".jpeg", ".jp2", ".webp", ".gif", ".bmp",
        ".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx", ".html", ".htm",
        ".md", ".markdown", ".txt"
    ]);
    LitMTransPort.DIRECT_TEXT_INPUT_EXTENSIONS = Object.freeze([".md", ".markdown", ".txt", ".html", ".htm"]);
    function inputExtension(path) {
        const clean = String(path || "").replace(/[?#].*$/, "").replace(/\\/g, "/");
        const name = clean.slice(clean.lastIndexOf("/") + 1);
        const index = name.lastIndexOf(".");
        return index > 0 ? name.slice(index).toLowerCase() : "";
    }
    LitMTransPort.inputExtension = inputExtension;
    function is_supported_input_file(path) {
        return LitMTransPort.SUPPORTED_INPUT_EXTENSIONS.includes(inputExtension(path));
    }
    LitMTransPort.is_supported_input_file = is_supported_input_file;
    function is_direct_text_input_file(path) {
        return LitMTransPort.DIRECT_TEXT_INPUT_EXTENSIONS.includes(inputExtension(path));
    }
    LitMTransPort.is_direct_text_input_file = is_direct_text_input_file;
    function inputKind(path) {
        const ext = inputExtension(path);
        if (ext === ".pdf")
            return "pdf";
        if ([".png", ".jpg", ".jpeg", ".jp2", ".webp", ".gif", ".bmp"].includes(ext))
            return "image";
        if ([".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx"].includes(ext))
            return "office";
        if ([".html", ".htm"].includes(ext))
            return "html";
        if ([".md", ".markdown"].includes(ext))
            return "markdown";
        if (ext === ".txt")
            return "text";
        return "unsupported";
    }
    LitMTransPort.inputKind = inputKind;
})(LitMTransPort || (LitMTransPort = {}));
var LitMTransPort;
(function (LitMTransPort) {
    const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
    const ILLEGAL = /[<>:"/\\|?*\u0000-\u001f]/g;
    function safe_document_stem(value, fallback = "document", maxLength = 96) {
        let text = String(value || "").normalize("NFC").replace(ILLEGAL, "_");
        text = text.replace(/[. ]+$/g, "").replace(/\s+/g, " ").trim();
        if (!text || WINDOWS_RESERVED.test(text))
            text = `${fallback}_${shortHash(String(value || fallback))}`;
        const limit = Math.max(16, Math.trunc(maxLength || 96));
        if (Array.from(text).length > limit) {
            const suffix = `_${shortHash(text)}`;
            text = Array.from(text).slice(0, Math.max(1, limit - suffix.length)).join("") + suffix;
        }
        return text;
    }
    LitMTransPort.safe_document_stem = safe_document_stem;
    function shortHash(value) {
        let hash = 0x811c9dc5;
        for (const ch of String(value || "")) {
            hash ^= ch.codePointAt(0) || 0;
            hash = Math.imul(hash, 0x01000193) >>> 0;
        }
        return hash.toString(16).padStart(8, "0");
    }
    LitMTransPort.shortHash = shortHash;
    function normalizeRelativePath(value) {
        const segments = [];
        for (const raw of String(value || "").normalize("NFC").replace(/\\/g, "/").split("/")) {
            const segment = raw.trim();
            if (!segment || segment === ".")
                continue;
            if (segment === "..") {
                if (!segments.length)
                    throw new LitMTransPort.PortError("INVALID_ZIP", `ZIP条目越出目标目录: ${value}`);
                segments.pop();
                continue;
            }
            segments.push(safe_document_stem(segment, "entry", 120));
        }
        if (!segments.length)
            throw new LitMTransPort.PortError("INVALID_ZIP", `ZIP条目路径为空: ${value}`);
        return segments.join("/");
    }
    LitMTransPort.normalizeRelativePath = normalizeRelativePath;
    function deduplicateRelativePath(path, used) {
        const normalized = normalizeRelativePath(path);
        const key = normalized.toLocaleLowerCase();
        if (!used.has(key)) {
            used.add(key);
            return normalized;
        }
        const slash = normalized.lastIndexOf("/");
        const dir = slash >= 0 ? normalized.slice(0, slash + 1) : "";
        const name = slash >= 0 ? normalized.slice(slash + 1) : normalized;
        const dot = name.lastIndexOf(".");
        const stem = dot > 0 ? name.slice(0, dot) : name;
        const ext = dot > 0 ? name.slice(dot) : "";
        for (let index = 2; index < 100000; index++) {
            const candidate = `${dir}${stem} (${index})${ext}`;
            const candidateKey = candidate.toLocaleLowerCase();
            if (!used.has(candidateKey)) {
                used.add(candidateKey);
                return candidate;
            }
        }
        throw new LitMTransPort.PortError("INVALID_ZIP", `无法为重复文件名分配安全名称: ${path}`);
    }
    LitMTransPort.deduplicateRelativePath = deduplicateRelativePath;
    function shortenWindowsPath(relativePath, maxLength = 220) {
        const normalized = normalizeRelativePath(relativePath);
        if (normalized.length <= maxLength)
            return normalized;
        const parts = normalized.split("/");
        const file = parts.pop() || "file";
        const dot = file.lastIndexOf(".");
        const ext = dot > 0 ? file.slice(dot) : "";
        const base = dot > 0 ? file.slice(0, dot) : file;
        const hash = shortHash(normalized);
        const compactFile = `${safe_document_stem(base, "file", 48)}_${hash}${ext.slice(0, 16)}`;
        const tail = parts.slice(-2).map(part => safe_document_stem(part, "dir", 36));
        const compact = [...tail, compactFile].join("/");
        return compact.length <= maxLength ? compact : `${hash}/${compactFile}`;
    }
    LitMTransPort.shortenWindowsPath = shortenWindowsPath;
    function commonDirectoryPrefix(paths) {
        const split = paths.map(normalizeRelativePath).map(path => path.split("/"));
        if (!split.length)
            return "";
        const prefix = [];
        for (let i = 0; i < Math.min(...split.map(parts => parts.length)); i++) {
            const value = split[0][i];
            if (split.every(parts => parts[i] === value))
                prefix.push(value);
            else
                break;
        }
        return prefix.join("/");
    }
    LitMTransPort.commonDirectoryPrefix = commonDirectoryPrefix;
})(LitMTransPort || (LitMTransPort = {}));
var LitMTransPort;
(function (LitMTransPort) {
    LitMTransPort.CACHE_SCHEMA_VERSION = 3;
    LitMTransPort.TRANSLATION_SCHEMA_VERSION = 3;
    function stableStringify(value) {
        if (value === null || typeof value !== "object")
            return JSON.stringify(value);
        if (Array.isArray(value))
            return `[${value.map(stableStringify).join(",")}]`;
        const object = value;
        return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${stableStringify(object[key])}`).join(",")}}`;
    }
    LitMTransPort.stableStringify = stableStringify;
    function fingerprintText(value) {
        const normalized = String(value || "").replace(/\r\n?/g, "\n").replace(/\u0000/g, "");
        let h1 = 0x811c9dc5, h2 = 0x9e3779b9;
        for (let i = 0; i < normalized.length; i++) {
            const code = normalized.charCodeAt(i);
            h1 = Math.imul((h1 ^ code) >>> 0, 0x01000193) >>> 0;
            h2 = Math.imul((h2 ^ (code + (i + 1) * 131)) >>> 0, 0x85ebca6b) >>> 0;
        }
        return `${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
    }
    LitMTransPort.fingerprintText = fingerprintText;
    function sourceFingerprint(document) {
        return fingerprintText(stableStringify({
            markdown: String(document.markdown || "").replace(/\r\n?/g, "\n"),
            pages: (document.pages || []).map(page => ({
                page: page.page, width: page.width, height: page.height,
                blocks: (page.blocks || []).map(block => ({ id: block.id, type: block.type, text: block.text, bbox: block.bbox, order: block.order }))
            })),
            images: (document.images || []).map(image => ({ id: image.id, target: image.cleanTarget, page: image.page, bbox: image.bbox })),
            formulas: (document.formulas || []).map(formula => ({ id: formula.id, tex: formula.tex, page: formula.page, bbox: formula.bbox }))
        }));
    }
    LitMTransPort.sourceFingerprint = sourceFingerprint;
    function translationIsCurrent(artifact, currentFingerprint) {
        return Boolean(artifact && artifact.status === "complete" && artifact.sourceFingerprint && artifact.sourceFingerprint === currentFingerprint);
    }
    LitMTransPort.translationIsCurrent = translationIsCurrent;
    function assertTranslationCurrent(artifact, currentFingerprint) {
        if (!translationIsCurrent(artifact, currentFingerprint)) {
            throw new LitMTransPort.PortError("STALE_TRANSLATION", "解析正文已变化，当前译文已失效，请重新翻译", {
                detail: { published: artifact?.sourceFingerprint || "", current: currentFingerprint }
            });
        }
    }
    LitMTransPort.assertTranslationCurrent = assertTranslationCurrent;
    function migrateCacheManifest(input, documentID = "") {
        const value = input && typeof input === "object" ? input : {};
        const files = value.files && typeof value.files === "object" && !Array.isArray(value.files) ? value.files : {};
        const translations = value.translations && typeof value.translations === "object" && !Array.isArray(value.translations)
            ? value.translations : {};
        const archives = Array.isArray(value.archives) ? value.archives.filter(item => item && typeof item === "object") : [];
        return {
            schemaVersion: LitMTransPort.CACHE_SCHEMA_VERSION,
            documentID: String(value.documentID || documentID || ""),
            sourceFingerprint: String(value.sourceFingerprint || value.source_fingerprint || ""),
            parsedAt: String(value.parsedAt || value.parsed_at || ""),
            files: { ...files }, translations: { ...translations }, archives: archives.map(entry => ({ ...entry }))
        };
    }
    LitMTransPort.migrateCacheManifest = migrateCacheManifest;
    function latest_translation_path(documentID, kind = "stream") {
        return `${LitMTransPort.safe_document_stem(documentID, "document")}/translation/${kind}/latest.json`;
    }
    LitMTransPort.latest_translation_path = latest_translation_path;
    function currentWorkDir(documentID) { return `${LitMTransPort.safe_document_stem(documentID, "document")}/work`; }
    LitMTransPort.currentWorkDir = currentWorkDir;
    function output_dir_for_pdf(documentID) { return `${LitMTransPort.safe_document_stem(documentID, "document")}/parsed`; }
    LitMTransPort.output_dir_for_pdf = output_dir_for_pdf;
    function latest_output_dir_for_file(documentID) { return output_dir_for_pdf(documentID); }
    LitMTransPort.latest_output_dir_for_file = latest_output_dir_for_file;
    function markGeneratedOutputDir(manifest, marker = "generated-output") {
        return { ...manifest, files: { ...manifest.files, [`.${marker}`]: { size: 0, hash: marker } } };
    }
    LitMTransPort.markGeneratedOutputDir = markGeneratedOutputDir;
    function isGeneratedOutputDir(manifest, marker = "generated-output") {
        return Boolean(manifest.files?.[`.${marker}`]);
    }
    LitMTransPort.isGeneratedOutputDir = isGeneratedOutputDir;
    function createArchiveEntry(documentID, previousFingerprint, nextFingerprint, files, sessions, now = new Date()) {
        const createdAt = now.toISOString();
        return {
            archiveID: `${createdAt.replace(/[^0-9]/g, "").slice(0, 17)}-${LitMTransPort.shortHash(previousFingerprint || documentID)}`,
            documentID, sourceFingerprint: previousFingerprint, nextSourceFingerprint: nextFingerprint,
            createdAt, files: [...new Set(files.filter(Boolean))], chatSessionIDs: [...new Set(sessions.filter(Boolean))]
        };
    }
    LitMTransPort.createArchiveEntry = createArchiveEntry;
})(LitMTransPort || (LitMTransPort = {}));
var LitMTransPort;
(function (LitMTransPort) {
    function createAtomicPublishPlan(files, transactionID = `publish-${Date.now()}`) {
        const seen = new Set();
        const normalized = [];
        for (const file of files) {
            const temporaryPath = String(file.temporaryPath || "");
            const destinationPath = String(file.destinationPath || "");
            if (!temporaryPath || !destinationPath)
                throw new LitMTransPort.PortError("PUBLISH_FAILED", "发布路径不能为空");
            if (seen.has(destinationPath))
                throw new LitMTransPort.PortError("PUBLISH_FAILED", `同一事务重复发布目标: ${destinationPath}`);
            seen.add(destinationPath);
            normalized.push({ temporaryPath, destinationPath, rollbackPath: `${destinationPath}.rollback-${LitMTransPort.safe_document_stem(transactionID, "tx", 48)}` });
        }
        return { transactionID, files: normalized };
    }
    LitMTransPort.createAtomicPublishPlan = createAtomicPublishPlan;
    async function atomicPublish(store, plan) {
        const movedToRollback = [];
        const published = [];
        try {
            for (const file of plan.files) {
                if (!await store.exists(file.temporaryPath))
                    throw new LitMTransPort.PortError("PUBLISH_FAILED", `临时结果不存在: ${file.temporaryPath}`);
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
            for (const file of movedToRollback)
                await store.remove(file.rollbackPath, true);
        }
        catch (error) {
            const rollbackErrors = [];
            for (const file of published.reverse()) {
                try {
                    await store.remove(file.destinationPath, true);
                }
                catch (rollbackError) {
                    rollbackErrors.push(String(rollbackError));
                }
            }
            for (const file of movedToRollback.reverse()) {
                try {
                    if (await store.exists(file.rollbackPath))
                        await store.move(file.rollbackPath, file.destinationPath);
                }
                catch (rollbackError) {
                    rollbackErrors.push(String(rollbackError));
                }
            }
            throw new LitMTransPort.PortError("PUBLISH_FAILED", "结果原子发布失败，已尝试恢复上一版", {
                detail: { transactionID: plan.transactionID, rollbackErrors }, cause: error
            });
        }
    }
    LitMTransPort.atomicPublish = atomicPublish;
})(LitMTransPort || (LitMTransPort = {}));
var LitMTransPort;
(function (LitMTransPort) {
    function cleanMarkdownText(value) {
        return String(value || "").replace(/\r\n?/g, "\n").replace(/\u0000/g, "").replace(/[ \t]+$/gm, "").replace(/\n{4,}/g, "\n\n\n").trim() + "\n";
    }
    LitMTransPort.cleanMarkdownText = cleanMarkdownText;
    function markdownBlocks(markdown) {
        const text = cleanMarkdownText(markdown);
        const blocks = [];
        let start = 0, inFence = false, fence = "", current = [];
        const flush = (end) => {
            const value = current.join("\n").trimEnd();
            if (value.trim()) {
                let kind = "paragraph";
                if (/^```|^~~~/.test(value))
                    kind = "code";
                else if (/^#{1,6}\s/.test(value))
                    kind = "heading";
                else if (/^(?:\|.*\|\s*\n\|?\s*:?-{3,})/s.test(value))
                    kind = "table";
                else if (/^\s*[-*+]\s|^\s*\d+[.)]\s/.test(value))
                    kind = "list";
                else if (/^>/.test(value))
                    kind = "quote";
                else if (/^!\[[^\]]*\]\([^)]+\)/.test(value))
                    kind = "image";
                else if (/^\$\$[\s\S]*\$\$$/.test(value) || /^\\\[[\s\S]*\\\]$/.test(value))
                    kind = "formula";
                blocks.push({ index: blocks.length, kind, text: value, start, end });
            }
            current = [];
            start = end;
        };
        let offset = 0;
        for (const line of text.split("\n")) {
            const match = line.match(/^\s*(```+|~~~+)/);
            if (match) {
                if (!inFence) {
                    inFence = true;
                    fence = match[1][0];
                }
                else if (match[1][0] === fence)
                    inFence = false;
            }
            if (!inFence && !line.trim() && current.length)
                flush(offset);
            else if (line.trim() || current.length || inFence)
                current.push(line);
            offset += line.length + 1;
        }
        flush(text.length);
        return blocks;
    }
    LitMTransPort.markdownBlocks = markdownBlocks;
    function markdown_block_translation_text(block) {
        const text = String(block || "");
        if (/^```|^~~~/.test(text.trim()))
            return "";
        if (/^!\[[^\]]*\]\([^)]+\)\s*$/.test(text.trim()))
            return "";
        return text
            .replace(/^#{1,6}\s+/, "")
            .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
            .replace(/!\[[^\]]*\]\([^)]+\)/g, "")
            .trim();
    }
    LitMTransPort.markdown_block_translation_text = markdown_block_translation_text;
    function splitMarkdownByChars(markdown, maxChars) {
        const limit = Math.max(1000, Math.trunc(maxChars || 135000));
        const blocks = markdownBlocks(markdown);
        const chunks = [];
        let current = [], length = 0;
        for (const block of blocks) {
            const addition = block.text.length + (current.length ? 2 : 0);
            if (current.length && length + addition > limit) {
                chunks.push(current.join("\n\n") + "\n");
                current = [];
                length = 0;
            }
            if (block.text.length > limit && block.kind === "paragraph") {
                const sentences = block.text.split(/(?<=[.!?。！？])\s+/);
                for (const sentence of sentences) {
                    if (current.length && length + sentence.length + 1 > limit) {
                        chunks.push(current.join(" ") + "\n");
                        current = [];
                        length = 0;
                    }
                    current.push(sentence);
                    length += sentence.length + 1;
                }
            }
            else {
                current.push(block.text);
                length += addition;
            }
        }
        if (current.length)
            chunks.push(current.join("\n\n") + "\n");
        return chunks;
    }
    LitMTransPort.splitMarkdownByChars = splitMarkdownByChars;
    function normalizeMarkdownImageTargets(markdown, resolve) {
        return String(markdown || "").replace(/(!\[[^\]]*\]\()([^)]+)(\))/g, (_match, prefix, target, suffix) => `${prefix}${resolve(String(target).trim())}${suffix}`);
    }
    LitMTransPort.normalizeMarkdownImageTargets = normalizeMarkdownImageTargets;
    function markerDetected(text, marker) {
        const value = String(text || ""), expected = String(marker || "");
        if (!expected)
            return false;
        if (value.includes(expected))
            return true;
        const digits = expected.replace(/\D/g, "");
        if (!digits)
            return false;
        return new RegExp(digits.split("").join("[\\s_\\-.,:;|/\\\\]*")).test(value);
    }
    LitMTransPort.markerDetected = markerDetected;
    function stripCompletionMarker(text, marker) {
        let value = String(text || "");
        const index = marker ? value.lastIndexOf(marker) : -1;
        if (index >= 0)
            value = value.slice(0, index);
        return value.replace(/(?:结束标记|截止标记|完成标记|end\s*marker|completion\s*token)\s*[:：]?\s*$/gim, "").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
    }
    LitMTransPort.stripCompletionMarker = stripCompletionMarker;
    function formulaDelimiterBalance(text) {
        const value = String(text || "").replace(/\\\$/g, "");
        const display = (value.match(/\$\$/g) || []).length;
        const withoutDisplay = value.replace(/\$\$/g, "");
        const inline = (withoutDisplay.match(/\$/g) || []).length;
        const brackets = (value.match(/\\\[/g) || []).length - (value.match(/\\\]/g) || []).length;
        return { ok: display % 2 === 0 && inline % 2 === 0 && brackets === 0, inline, display, brackets };
    }
    LitMTransPort.formulaDelimiterBalance = formulaDelimiterBalance;
})(LitMTransPort || (LitMTransPort = {}));
var LitMTransPort;
(function (LitMTransPort) {
    function referenceQuoteIdentity(quote) {
        return LitMTransPort.fingerprintText(LitMTransPort.stableStringify({
            type: quote.type || "text", text: String(quote.text || "").trim(), pane: quote.pane || "source",
            page: quote.page ?? null, blockID: quote.blockID || "", imageTarget: quote.imageTarget || "", formula: quote.formula || ""
        }));
    }
    LitMTransPort.referenceQuoteIdentity = referenceQuoteIdentity;
    function normalizeReferenceQuote(value) {
        const type = ["image", "formula"].includes(String(value.type)) ? value.type : "text";
        const quote = {
            id: String(value.id || ""), type, text: String(value.text || "").trim(),
            pane: value.pane === "translation" ? "translation" : "source",
            page: Number.isFinite(Number(value.page)) ? Number(value.page) : null,
            blockID: String(value.blockID || ""), imageTarget: String(value.imageTarget || ""),
            formula: String(value.formula || ""), title: String(value.title || "")
        };
        if (!quote.id)
            quote.id = `quote-${referenceQuoteIdentity(quote)}`;
        return quote;
    }
    LitMTransPort.normalizeReferenceQuote = normalizeReferenceQuote;
    function appendPendingReferenceQuote(quotes, quote) {
        const normalized = normalizeReferenceQuote(quote);
        const id = referenceQuoteIdentity(normalized);
        if (quotes.some(item => referenceQuoteIdentity(item) === id))
            return [...quotes];
        return [...quotes, normalized];
    }
    LitMTransPort.appendPendingReferenceQuote = appendPendingReferenceQuote;
    function combinedPendingReferenceQuote(quotes) {
        const normalized = quotes.map(normalizeReferenceQuote).filter(item => item.text || item.imageTarget || item.formula);
        if (!normalized.length)
            return null;
        if (normalized.length === 1)
            return normalized[0];
        return normalizeReferenceQuote({
            type: "text", pane: normalized[0].pane, title: `组合引用（${normalized.length} 项）`,
            text: normalized.map((quote, index) => `[引用 ${index + 1}] ${quote.title || quote.type}\n${quote.text || quote.formula || quote.imageTarget}`).join("\n\n")
        });
    }
    LitMTransPort.combinedPendingReferenceQuote = combinedPendingReferenceQuote;
    function locateReference(document, quote) {
        const normalized = normalizeReferenceQuote(quote);
        for (const page of document.pages || []) {
            const block = page.blocks.find(item => item.id === normalized.blockID || (normalized.text && item.text.includes(normalized.text.slice(0, 80))));
            if (block)
                return { page: page.page, blockID: block.id, bbox: block.bbox };
        }
        return { page: normalized.page, blockID: normalized.blockID, bbox: null };
    }
    LitMTransPort.locateReference = locateReference;
})(LitMTransPort || (LitMTransPort = {}));
var LitMTransPort;
(function (LitMTransPort) {
    function generatedOutputMarkerPath(documentID) { return `${LitMTransPort.safe_document_stem(documentID, "document")}/.generated-output`; }
    LitMTransPort.generatedOutputMarkerPath = generatedOutputMarkerPath;
    function targetLanguageInstruction(targetLanguage) {
        const language = String(targetLanguage || "简体中文").trim();
        return ["简体中文", "繁体中文"].includes(language)
            ? `Use ${language}. Prefer standard academic Chinese terminology and retain necessary English abbreviations.`
            : `Use ${language}. Do not switch to Chinese unless Chinese source text itself must be translated into ${language}.`;
    }
    LitMTransPort.targetLanguageInstruction = targetLanguageInstruction;
    function buildKeyPointsPromptForDocument(targetLanguage = "简体中文") {
        return `请阅读完整文档，以${targetLanguage}输出：研究问题、方法、关键数据、结论、限制、可复现性线索。引用文档中的页码、图表或公式时保留定位信息；不要虚构原文没有的内容。`;
    }
    LitMTransPort.buildKeyPointsPromptForDocument = buildKeyPointsPromptForDocument;
    function buildTranslationChunks(markdown, maxChars = 135000) {
        let offset = 0;
        return LitMTransPort.splitMarkdownByChars(markdown, maxChars).map((part, index) => {
            const start = String(markdown || "").indexOf(part.trim(), offset);
            const actualStart = start >= 0 ? start : offset;
            const end = actualStart + part.length;
            offset = end;
            const marker = `[[AITL_END_${String(index + 1).padStart(4, "0")}_${LitMTransPort.shortHash(part)}]]`;
            return { id: `chunk-${String(index + 1).padStart(4, "0")}`, index, start: actualStart, end, markdown: part, marker };
        });
    }
    LitMTransPort.buildTranslationChunks = buildTranslationChunks;
    function buildStreamTranslationMessages(chunk, options) {
        const reference = String(options.referenceContext || "").trim();
        const previous = String(options.previousTranslation || "").trim();
        const system = [
            "You are an academic document translator.", targetLanguageInstruction(options.targetLanguage),
            "Preserve Markdown structure, image targets, formulas, citation labels, headings, tables, lists and code.",
            "Do not summarize, omit, merge, reorder or invent content.",
            `Append the exact completion marker ${chunk.marker} after the translated chunk.`
        ].join("\n");
        const context = [reference ? `Reference material:\n${reference}` : "", previous ? `Previous translated tail for continuity:\n${previous.slice(-12000)}` : ""].filter(Boolean).join("\n\n");
        return [
            { role: "system", content: system },
            { role: "user", content: `${context}${context ? "\n\n" : ""}Translate this source chunk:\n\n${chunk.markdown}` }
        ];
    }
    LitMTransPort.buildStreamTranslationMessages = buildStreamTranslationMessages;
    function acceptStreamChunk(raw, chunk) {
        if (!LitMTransPort.markerDetected(raw, chunk.marker))
            throw new LitMTransPort.PortError("MODEL_PROTOCOL", `模型未返回分块结束标记: ${chunk.id}`, { retryable: true });
        const cleaned = LitMTransPort.stripCompletionMarker(raw, chunk.marker);
        const math = LitMTransPort.formulaDelimiterBalance(cleaned);
        if (!math.ok)
            throw new LitMTransPort.PortError("MODEL_PROTOCOL", `译文公式分隔符不完整: ${chunk.id}`, { retryable: true, detail: math });
        return cleaned;
    }
    LitMTransPort.acceptStreamChunk = acceptStreamChunk;
    function mergeTranslatedChunks(chunks) {
        const ordered = [...chunks].sort((a, b) => a.chunk.index - b.chunk.index);
        for (let index = 0; index < ordered.length; index++) {
            if (ordered[index].chunk.index !== index)
                throw new LitMTransPort.PortError("TRANSLATION_FAILED", `译文分块缺失或乱序: expected ${index}`);
        }
        return LitMTransPort.cleanMarkdownText(ordered.map(item => item.text.trim()).join("\n\n"));
    }
    LitMTransPort.mergeTranslatedChunks = mergeTranslatedChunks;
    function createTranslationArtifact(documentID, fingerprint, kind, values) {
        return {
            schemaVersion: LitMTransPort.TRANSLATION_SCHEMA_VERSION, kind, documentID, sourceFingerprint: fingerprint,
            provider: String(values.provider || ""), model: String(values.model || ""), targetLanguage: String(values.targetLanguage || "简体中文"),
            status: values.status || "complete", markdown: String(values.markdown || ""), translations: { ...(values.translations || {}) },
            formulaReplacements: { ...(values.formulaReplacements || {}) },
            usage: values.usage || { inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0, reasoningTokens: 0 },
            createdAt: String(values.createdAt || new Date().toISOString()), error: String(values.error || "")
        };
    }
    LitMTransPort.createTranslationArtifact = createTranslationArtifact;
    function shouldPublishTranslation(artifact, expectedFingerprint) {
        return artifact.status === "complete" && artifact.sourceFingerprint === expectedFingerprint && (Boolean(artifact.markdown.trim()) || Object.keys(artifact.translations).length > 0);
    }
    LitMTransPort.shouldPublishTranslation = shouldPublishTranslation;
    function readKeyFileLines(value) { return String(value || "").split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith("#")); }
    LitMTransPort.readKeyFileLines = readKeyFileLines;
    function loadLabelledSecret(lines, label) {
        const normalized = String(label || "").toLowerCase();
        for (const line of lines) {
            const match = line.match(/^\s*([^:=]+)\s*[:=]\s*(.+)\s*$/);
            if (match && match[1].trim().toLowerCase() === normalized)
                return match[2].trim();
        }
        return "";
    }
    LitMTransPort.loadLabelledSecret = loadLabelledSecret;
    function loadKeySetting(lines, labels) {
        for (const label of labels) {
            const value = loadLabelledSecret(lines, label);
            if (value)
                return value;
        }
        return "";
    }
    LitMTransPort.loadKeySetting = loadKeySetting;
    function saveKey(store, value) {
        LitMTransPort.saveSecret(store, "mineru", "official", value);
        return LitMTransPort.secretPath("mineru", "official");
    }
    LitMTransPort.saveKey = saveKey;
    function createReaderWindow(mode) {
        return Object.freeze({ ...LitMTransPort.readingModeContract(mode) });
    }
    LitMTransPort.createReaderWindow = createReaderWindow;
})(LitMTransPort || (LitMTransPort = {}));
var LitMTransPort;
(function (LitMTransPort) {
    const TRANSLATABLE_TYPES = new Set(["title", "text", "table_caption", "table_footnote", "chart_caption", "image_caption", "image_footnote", "ref_text"]);
    function normalizeBBox(value) {
        const source = Array.isArray(value) ? value : (value && typeof value === "object" ? [
            value.x0 ?? value.left,
            value.y0 ?? value.top,
            value.x1 ?? value.right,
            value.y1 ?? value.bottom
        ] : []);
        if (source.length < 4)
            return null;
        const numbers = source.slice(0, 4).map(Number);
        if (numbers.some(value => !Number.isFinite(value)))
            return null;
        const [x0, y0, x1, y1] = numbers;
        return { x0: Math.min(x0, x1), y0: Math.min(y0, y1), x1: Math.max(x0, x1), y1: Math.max(y0, y1) };
    }
    LitMTransPort.normalizeBBox = normalizeBBox;
    function normalizeBlockType(value) {
        const type = String(value || "text").toLowerCase().replace(/[\s-]+/g, "_");
        const aliases = { paragraph: "text", body: "text", heading: "title", equation: "interline_equation", image: "image", figure: "image", table_foot_note: "table_footnote" };
        return aliases[type] || type;
    }
    LitMTransPort.normalizeBlockType = normalizeBlockType;
    function layoutLogicalLines(lines) {
        if (!Array.isArray(lines))
            return [];
        const output = [];
        for (const line of lines) {
            if (!line || typeof line !== "object")
                continue;
            const spans = Array.isArray(line.spans)
                ? line.spans
                : [];
            const fragments = spans
                .filter(span => span && typeof span === "object")
                .map(span => {
                const value = span;
                return String(value.content ?? value.text ?? value.value ?? "");
            })
                .filter(Boolean);
            if (fragments.length)
                output.push(...fragments.join("").replace(/\r\n?/g, "\n").split("\n"));
        }
        return output;
    }
    LitMTransPort.layoutLogicalLines = layoutLogicalLines;
    function parseTocRows(lines) {
        const entries = [];
        let nonblank = 0;
        const pattern = /^\s*(\d+(?:\.\d+)*\.?)\s+(.+?)\s*(?:\.{2,}|…{2,}|·{2,}|-{3,})\s*(\d+|[ivxlcdm]+)\s*$/i;
        for (const rawLine of layoutLogicalLines(lines)) {
            const text = String(rawLine || "").replace(/\s+/g, " ").trim();
            if (!text) {
                entries.push({ gap: true });
                continue;
            }
            nonblank++;
            const match = text.match(pattern);
            if (!match) {
                entries.push({ text });
                continue;
            }
            const number = match[1];
            entries.push({
                number,
                title: match[2].trim(),
                page: match[3],
                level: Math.max(0, number.replace(/\.$/, "").split(".").filter(Boolean).length - 1)
            });
        }
        const matched = entries.filter(entry => entry.page).length;
        return matched >= 6 && matched / Math.max(1, nonblank) >= .70 ? entries : null;
    }
    LitMTransPort.parseTocRows = parseTocRows;
    function codeTextFromLayoutBlock(raw) {
        const lines = [];
        const visit = (value) => {
            if (!value || typeof value !== "object")
                return;
            const record = value;
            for (const line of Array.isArray(record.lines) ? record.lines : []) {
                if (!line || typeof line !== "object")
                    continue;
                const spans = Array.isArray(line.spans)
                    ? line.spans
                    : [];
                lines.push(spans.map(span => {
                    if (!span || typeof span !== "object")
                        return "";
                    const item = span;
                    return String(item.content ?? item.text ?? item.value ?? "");
                }).join(""));
            }
            for (const child of Array.isArray(record.blocks) ? record.blocks : [])
                visit(child);
        };
        visit(raw);
        return lines.join("\n").replace(/^\n+|\n+$/g, "");
    }
    LitMTransPort.codeTextFromLayoutBlock = codeTextFromLayoutBlock;
    function normalizeLayoutBlock(raw, page, order) {
        const type = normalizeBlockType(raw.type || raw.block_type || raw.category);
        const id = String(raw.id || raw.block_id || `p${page}-b${order}`);
        const preservedCode = ["code", "code_body"].includes(type) ? codeTextFromLayoutBlock(raw) : "";
        const tocRows = type === "text" ? parseTocRows(raw.lines) : null;
        const contentsText = tocRows ? layoutLogicalLines(raw.lines).join("\n").trim() : "";
        const text = String(preservedCode || contentsText || raw.text || raw.content || raw.markdown || raw.html || "").replace(/\r\n?/g, "\n");
        const imagePath = String(raw.image_path || raw.imagePath || raw.img_path || raw.path || "");
        const formulaIDs = (Array.isArray(raw.formula_ids) ? raw.formula_ids : Array.isArray(raw.formulas) ? raw.formulas : []).map(value => typeof value === "object" ? String(value.id || "") : String(value)).filter(Boolean);
        return {
            id, type, text, translatedText: String(raw.translatedText || raw.translated_text || ""), page,
            bbox: normalizeBBox(raw.bbox || raw.box || raw.rect), order,
            translatable: TRANSLATABLE_TYPES.has(type) && Boolean(text.trim()), imagePath,
            formulaIDs, referenceIDs: (Array.isArray(raw.reference_ids) ? raw.reference_ids : []).map(String),
            parentID: String(raw.parent_id || raw.parentID || ""),
            metadata: {
                tocRows: (tocRows || []),
                codeLanguage: String(raw.guess_lang || raw.guessLang || "")
            }
        };
    }
    LitMTransPort.normalizeLayoutBlock = normalizeLayoutBlock;
    function collectRawPages(raw) {
        if (Array.isArray(raw))
            return raw.map(item => item && typeof item === "object" ? item : {});
        if (!raw || typeof raw !== "object")
            return [];
        const value = raw;
        for (const key of ["pages", "pdf_info", "layout", "page_info"]) {
            if (Array.isArray(value[key]))
                return value[key].map(item => item && typeof item === "object" ? item : {});
        }
        return [];
    }
    LitMTransPort.collectRawPages = collectRawPages;
    function normalizeLayoutDocument(raw, documentID, markdown = "", imageMap = []) {
        const pages = collectRawPages(raw).map((pageRaw, index) => {
            const page = Number(pageRaw.page_idx ?? pageRaw.page_index ?? pageRaw.page_no ?? pageRaw.page ?? index) + (pageRaw.page_idx !== undefined || pageRaw.page_index !== undefined ? 1 : 0);
            const width = Math.max(1, Number(pageRaw.width || pageRaw.page_size?.width || 1000));
            const height = Math.max(1, Number(pageRaw.height || pageRaw.page_size?.height || 1400));
            const rawBlocks = (Array.isArray(pageRaw.blocks) ? pageRaw.blocks : Array.isArray(pageRaw.para_blocks) ? pageRaw.para_blocks : Array.isArray(pageRaw.layout_dets) ? pageRaw.layout_dets : []);
            const blocks = [];
            const visit = (items, parentID = "") => {
                for (const item of items) {
                    if (!item || typeof item !== "object")
                        continue;
                    const rawBlock = item;
                    const block = normalizeLayoutBlock({ ...rawBlock, parent_id: rawBlock.parent_id || parentID }, page || index + 1, blocks.length);
                    blocks.push(block);
                    const children = (Array.isArray(rawBlock.blocks) ? rawBlock.blocks : Array.isArray(rawBlock.children) ? rawBlock.children : []);
                    if (children.length)
                        visit(children, block.id);
                }
            };
            visit(rawBlocks);
            return { page: page || index + 1, width, height, blocks, imageIDs: [], formulaIDs: [...new Set(blocks.flatMap(block => block.formulaIDs))] };
        });
        const formulas = [];
        for (const page of pages)
            for (const block of page.blocks) {
                if (["interline_equation", "inline_equation", "formula"].includes(block.type) && block.text.trim()) {
                    const id = block.formulaIDs[0] || `formula-${block.id}`;
                    block.formulaIDs = [id];
                    formulas.push({ id, tex: stripTexWrappers(block.text), page: page.page, bbox: block.bbox, inline: block.type === "inline_equation" });
                }
            }
        for (const image of imageMap) {
            const page = pages.find(item => item.page === image.page);
            if (page)
                page.imageIDs.push(image.id);
        }
        const partial = {
            schemaVersion: 3, documentID, title: "", sourcePathHint: "", markdown: LitMTransPort.cleanMarkdownText(markdown), pages,
            images: imageMap.map(image => ({ ...image })), formulas, references: [], sourceFingerprint: "", generatedAt: new Date().toISOString(), metadata: {}
        };
        partial.sourceFingerprint = LitMTransPort.sourceFingerprint(partial);
        return partial;
    }
    LitMTransPort.normalizeLayoutDocument = normalizeLayoutDocument;
    function stripTexWrappers(value) {
        let text = String(value || "").trim();
        for (const pair of [["$$", "$$"], ["\\[", "\\]"], ["\\(", "\\)"], ["$", "$"]]) {
            if (text.startsWith(pair[0]) && text.endsWith(pair[1]) && text.length >= pair[0].length + pair[1].length)
                text = text.slice(pair[0].length, -pair[1].length).trim();
        }
        return text;
    }
    LitMTransPort.stripTexWrappers = stripTexWrappers;
    function extractBraced(value, start) {
        if (value[start] !== "{")
            return null;
        let depth = 0;
        for (let index = start; index < value.length; index++) {
            if (value[index] === "{" && value[index - 1] !== "\\")
                depth++;
            if (value[index] === "}" && value[index - 1] !== "\\")
                depth--;
            if (depth === 0)
                return { text: value.slice(start + 1, index), end: index + 1 };
        }
        return null;
    }
    LitMTransPort.extractBraced = extractBraced;
    function texCommandToText(command) {
        const map = { mu: "μ", alpha: "α", beta: "β", gamma: "γ", delta: "δ", cdot: "·", times: "×", le: "≤", ge: "≥", neq: "≠", pm: "±", prime: "′", star: "*" };
        return map[String(command || "").replace(/^\\/, "")] || String(command || "");
    }
    LitMTransPort.texCommandToText = texCommandToText;
    function splitTexGroup(value) { return String(value || "").split(/(?<!\\)[,;]/).map(item => item.trim()).filter(Boolean); }
    LitMTransPort.splitTexGroup = splitTexGroup;
    function parseTexishSegments(value) {
        const segments = [];
        const pattern = /\\[A-Za-z]+|[^\\]+|\\./g;
        for (const match of String(value || "").matchAll(pattern))
            segments.push({ kind: match[0].startsWith("\\") ? "command" : "text", value: match[0] });
        return segments;
    }
    LitMTransPort.parseTexishSegments = parseTexishSegments;
    function normalizeHtmlTableCellText(value) { return String(value || "").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/gi, " ").trim(); }
    LitMTransPort.normalizeHtmlTableCellText = normalizeHtmlTableCellText;
    function parseRawHtmlTable(html) {
        const rows = [];
        for (const row of String(html || "").matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
            rows.push([...row[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(cell => normalizeHtmlTableCellText(cell[1])));
        }
        return rows.filter(row => row.length);
    }
    LitMTransPort.parseRawHtmlTable = parseRawHtmlTable;
    function splitMarkdownTableCells(row) {
        const text = String(row || "").trim().replace(/^\|/, "").replace(/\|$/, "");
        const cells = [];
        let current = "", escaped = false;
        for (const char of text) {
            if (escaped) {
                current += char;
                escaped = false;
            }
            else if (char === "\\") {
                current += char;
                escaped = true;
            }
            else if (char === "|") {
                cells.push(current.trim());
                current = "";
            }
            else
                current += char;
        }
        cells.push(current.trim());
        return cells;
    }
    LitMTransPort.splitMarkdownTableCells = splitMarkdownTableCells;
    function isMarkdownSeparatorRow(row) { return splitMarkdownTableCells(row).every(cell => /^:?-{3,}:?$/.test(cell)); }
    LitMTransPort.isMarkdownSeparatorRow = isMarkdownSeparatorRow;
    function markdownTableRow(cells) { return `| ${cells.map(cell => String(cell || "").replace(/\|/g, "\\|")).join(" | ")} |`; }
    LitMTransPort.markdownTableRow = markdownTableRow;
    function repairPipeTableBlock(block) {
        const rows = String(block || "").split("\n").filter(line => line.includes("|"));
        if (rows.length < 2)
            return block;
        const parsed = rows.map(splitMarkdownTableCells);
        const width = Math.max(...parsed.map(row => row.length));
        const normalized = parsed.map(row => [...row, ...Array(Math.max(0, width - row.length)).fill("")]);
        if (!isMarkdownSeparatorRow(markdownTableRow(normalized[1])))
            normalized.splice(1, 0, Array(width).fill("---"));
        return normalized.map(markdownTableRow).join("\n");
    }
    LitMTransPort.repairPipeTableBlock = repairPipeTableBlock;
    function repairMalformedPipeTables(markdown) {
        return LitMTransPort.markdownBlocks(markdown).map(block => block.kind === "table" || block.text.split("\n").filter(line => line.includes("|")).length >= 2 ? repairPipeTableBlock(block.text) : block.text).join("\n\n") + "\n";
    }
    LitMTransPort.repairMalformedPipeTables = repairMalformedPipeTables;
    function researchCss() { return ".layout-page{position:relative}.layout-block{position:absolute;overflow:visible}.layout-formula{white-space:nowrap}"; }
    LitMTransPort.researchCss = researchCss;
})(LitMTransPort || (LitMTransPort = {}));
var LitMTransPort;
(function (LitMTransPort) {
    function inlineTexToSafeText(value) {
        return LitMTransPort.stripTexWrappers(value).replace(/\\([A-Za-z]+)/g, (_m, command) => LitMTransPort.texCommandToText(command)).replace(/[{}]/g, "").replace(/\s+/g, " ").trim();
    }
    LitMTransPort.inlineTexToSafeText = inlineTexToSafeText;
    function neutralizeBrokenInlineTex(value) {
        const balance = LitMTransPort.formulaDelimiterBalance(value);
        if (balance.ok)
            return value;
        return String(value || "").replace(/(?<!\\)\$/g, "\\$").replace(/\\\[(?![\s\S]*\\\])/g, "[").replace(/\\\](?![\s\S]*\\\[)/g, "]");
    }
    LitMTransPort.neutralizeBrokenInlineTex = neutralizeBrokenInlineTex;
    function normalizeMathComparisonEntities(value) { return String(value || "").replace(/&lt;|＆lt；/gi, "<").replace(/&gt;|＆gt；/gi, ">").replace(/&le;|≤/gi, "≤").replace(/&ge;|≥/gi, "≥"); }
    LitMTransPort.normalizeMathComparisonEntities = normalizeMathComparisonEntities;
    function inlineFormulaIntegrityIssue(source, translated) {
        const sourceMath = String(source || "").match(/\$[^$]+\$|\\\([\s\S]*?\\\)/g) || [];
        const translatedMath = String(translated || "").match(/\$[^$]+\$|\\\([\s\S]*?\\\)/g) || [];
        if (translatedMath.length < sourceMath.length)
            return "inline-formula-missing";
        if (!LitMTransPort.formulaDelimiterBalance(translated).ok)
            return "inline-formula-unbalanced";
        return "";
    }
    LitMTransPort.inlineFormulaIntegrityIssue = inlineFormulaIntegrityIssue;
    function formulaTokenBody(value) {
        const token = String(value || "");
        if ((token.startsWith("\\(") && token.endsWith("\\)")) || (token.startsWith("\\[") && token.endsWith("\\]")))
            return token.slice(2, -2);
        if (token.startsWith("$$") && token.endsWith("$$"))
            return token.slice(2, -2);
        if (token.startsWith("$") && token.endsWith("$"))
            return token.slice(1, -1);
        return token;
    }
    function collapseRedundantFormulaBraces(value) {
        let output = String(value || "");
        let previous = "";
        while (output !== previous) {
            previous = output;
            output = output.replace(/\{\s*\{([^{}]*)\}\s*\}/g, "{$1}");
        }
        return output;
    }
    function normalizeMathBodyForRetry(value) {
        let output = String(value || "").normalize("NFKC")
            .replace(/&(?:amp;)?lt;/gi, "<")
            .replace(/&(?:amp;)?gt;/gi, ">")
            .replace(/\s+/g, " ")
            .trim()
            .replace(/(?:\\[,;:!]\s*|[,;:]\s+|\s+)\((?:i{1,3}|iv|v|[a-c])\)\s*$/i, "");
        output = collapseRedundantFormulaBraces(output);
        let previous = "";
        while (output !== previous) {
            previous = output;
            output = output
                .replace(/\\mathrm\s*\{([^{}]*)\}/g, "$1")
                .replace(/\\mathrm\s+([A-Za-z])/g, "$1")
                .replace(/\\mathrm(?=[A-Za-z])/g, "");
            output = collapseRedundantFormulaBraces(output);
        }
        return output.replace(/[\s,.;:，。；：、]+/g, "");
    }
    LitMTransPort.normalizeMathBodyForRetry = normalizeMathBodyForRetry;
    function inlineFormulaRetryIssue(source, translated) {
        const tokens = (value) => String(value || "").match(/\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)|(?<!\\)\$\$[\s\S]*?(?<!\\)\$\$|(?<!\\)\$(?![\s$])[^\n$]*(?<!\\)\$(?!\d)/g) || [];
        const isOCRNonMathToken = (token) => {
            const body = formulaTokenBody(token).replace(/&(?:amp;)?lt;/gi, "<").replace(/&(?:amp;)?gt;/gi, ">");
            return /^\s*\\operatorname\s*\{\s*e\s*q\s*\.?\s*\}\s*$/i.test(body)
                || /^\s*[-+]?\d+(?:\s*\.\s*\d+)?\s*\^\s*\{\s*\\circ\s*\}\s*\\mathrm\s*\{\s*[CFK]\s*\}\s*$/i.test(body)
                || /^\s*(?:\\mathrm\s*\{\s*)?a\s*l\s*\.\s*\^\s*\{\s*(?:\d\s*)+(?:[-,]\s*(?:\d\s*)+)*\}\s*\}?\s*$/i.test(body)
                || /^\s*\\mathrm\s*\{\s*(?:[A-Za-z]\s*){1,8}\.\s*\^\s*\{\s*(?:\d\s*)+(?:[-,]\s*(?:\d\s*)+)*\}\s*\}\s*$/i.test(body);
        };
        const sourceMath = tokens(source).filter(token => !isOCRNonMathToken(token));
        if (!sourceMath.length)
            return "";
        const translatedMath = tokens(translated).filter(token => !isOCRNonMathToken(token));
        // Same-count TeX differences are review-only.  Models often normalize
        // OCR notation or presentation wrappers correctly, so automatic layout
        // retries are reserved for an objectively missing formula token.
        if (translatedMath.length < sourceMath.length) {
            const missingIndex = translatedMath.length;
            return `公式${missingIndex + 1}缺少可渲染的数学内容`;
        }
        return "";
    }
    LitMTransPort.inlineFormulaRetryIssue = inlineFormulaRetryIssue;
    function plainBlockText(block) { return String(block.text || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(); }
    LitMTransPort.plainBlockText = plainBlockText;
    function iterTranslatableBlocks(document) { return document.pages.flatMap(page => page.blocks).filter(block => block.translatable); }
    LitMTransPort.iterTranslatableBlocks = iterTranslatableBlocks;
    function iterFormulaContext(document) {
        const blocks = new Map(document.pages.flatMap(page => page.blocks).map(block => [block.id, block]));
        return document.formulas.map(formula => {
            const block = [...blocks.values()].find(item => item.formulaIDs.includes(formula.id));
            return { formulaID: formula.id, tex: formula.tex, page: formula.page || block?.page || 0, blockID: block?.id || "" };
        });
    }
    LitMTransPort.iterFormulaContext = iterFormulaContext;
    const LATEX_SIMPLE_ESCAPE_COMMANDS = new Set([
        "nu", "nabla", "neq", "neg", "not", "notag", "notin", "nexists", "natural", "nobreakspace", "nobreakdash", "noalign", "nonumber", "nonumberline", "norm", "normalfont", "newcommand", "newenvironment", "newtheorem", "nocite", "numberwithin", "ne", "ncong", "ngeq", "ngeqq", "ngeqslant", "ngtr", "nleq", "nleqq", "nleqslant", "nless", "nmid", "nparallel", "nprec", "npreceq", "nrightarrow", "nRightarrow", "nsubset", "nsubseteq", "nsucc", "nsucceq", "nsupset", "nsupseteq", "ntriangleleft", "ntrianglelefteq", "ntriangleright", "ntrianglerighteq",
        "rho", "right", "rangle", "rbrace", "rceil", "rfloor", "rvert", "rVert", "ref", "relax", "renewcommand", "renewenvironment", "renewtheorem", "raisebox", "raggedleft", "raggedright", "roman", "rm", "rmfamily", "rule", "root", "rotatebox", "resizebox", "rightarrow", "rightharpoonup", "rightharpoondown", "rightleftarrows", "rightleftharpoons",
        "text", "textbf", "textit", "textrm", "textsf", "texttt", "textsl", "textsc", "textmd", "textup", "textnormal", "textstyle", "textcolor", "textwidth", "textheight", "textsuperscript", "textsubscript", "theoremstyle", "thispagestyle", "thanks", "title", "tableofcontents",
        "tau", "theta", "tilde", "times", "top", "to", "tfrac", "tbinom", "tag", "tan", "tanh", "tiny", "thinspace", "thickspace", "today", "triangle", "triangledown", "triangleleft", "triangleright", "tt", "ttfamily", "twocolumn", "typeout", "toprule", "midrule", "bottomrule"
    ]);
    function isLatexSimpleEscape(text, index) {
        const next = text[index + 1];
        if (next === "b" || next === "f")
            return /[a-zA-Z]/.test(text[index + 2] || "");
        if (!["n", "r", "t"].includes(next))
            return false;
        const command = text.slice(index + 1).match(/^([a-zA-Z]+)/)?.[1] || "";
        return LATEX_SIMPLE_ESCAPE_COMMANDS.has(command);
    }
    function repairInvalidJsonEscapes(value) {
        const text = String(value || "");
        const validSimple = new Set(["\"", "\\", "/", "b", "f", "n", "r", "t"]);
        let output = "";
        for (let index = 0; index < text.length; index++) {
            const character = text[index];
            if (character !== "\\") {
                output += character;
                continue;
            }
            const next = text[index + 1];
            if (next && validSimple.has(next)) {
                if (isLatexSimpleEscape(text, index)) {
                    output += "\\\\";
                }
                else {
                    output += character + next;
                    index++;
                }
            }
            else if (next === "u" && /^[0-9a-fA-F]{4}$/.test(text.slice(index + 2, index + 6))) {
                output += text.slice(index, index + 6);
                index += 5;
            }
            else {
                output += "\\\\";
            }
        }
        return output;
    }
    LitMTransPort.repairInvalidJsonEscapes = repairInvalidJsonEscapes;
    function extractJsonObject(value) {
        const text = String(value || "").replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
        const candidates = [text];
        const start = text.indexOf("{");
        const end = text.lastIndexOf("}");
        if (start >= 0 && end > start)
            candidates.push(text.slice(start, end + 1));
        let last = null;
        for (const candidate of candidates) {
            const repaired = repairInvalidJsonEscapes(candidate);
            const variants = repaired !== candidate ? [repaired, candidate] : [candidate];
            for (const variant of variants) {
                try {
                    return JSON.parse(variant);
                }
                catch (error) {
                    last = error;
                }
            }
        }
        throw new LitMTransPort.PortError("MODEL_PROTOCOL", "模型返回内容无法解析，请稍后重试", { retryable: true, detail: { cause: String(last?.message || last || "") } });
    }
    LitMTransPort.extractJsonObject = extractJsonObject;
    function blockPayload(record) { return { id: record.blockID, type: record.type, page: record.page, order: record.order, text: record.sourceText }; }
    LitMTransPort.blockPayload = blockPayload;
    function formulaPayload(record) { return { id: record.formulaID, tex: record.tex, page: record.page, block_id: record.blockID }; }
    LitMTransPort.formulaPayload = formulaPayload;
    function normalizeFormulaTex(value) { return LitMTransPort.stripTexWrappers(String(value || "")).replace(/\u0000/g, "").trim(); }
    LitMTransPort.normalizeFormulaTex = normalizeFormulaTex;
    function targetExpectsCjk(language) { return /中文|Chinese|日本語|Japanese|한국어|Korean/i.test(String(language || "")); }
    LitMTransPort.targetExpectsCjk = targetExpectsCjk;
    function cjkCount(value) { return (String(value || "").match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length; }
    LitMTransPort.cjkCount = cjkCount;
    function latinCount(value) { return (String(value || "").match(/[A-Za-z]/g) || []).length; }
    LitMTransPort.latinCount = latinCount;
    function normalizedCompareText(value) { return String(value || "").normalize("NFKC").toLowerCase().replace(/\s+/g, "").replace(/[\p{P}\p{S}]/gu, ""); }
    LitMTransPort.normalizedCompareText = normalizedCompareText;
    function sourceEquationNumbers(value) { return [...String(value || "").matchAll(/\((\d+(?:\.\d+)*)\)/g)].map(match => match[1]); }
    LitMTransPort.sourceEquationNumbers = sourceEquationNumbers;
    function repairEquationReferenceTranslation(source, translated) {
        let output = String(translated || "");
        for (const number of sourceEquationNumbers(source))
            if (!output.includes(`(${number})`))
                output += ` (${number})`;
        return output.trim();
    }
    LitMTransPort.repairEquationReferenceTranslation = repairEquationReferenceTranslation;
    function affiliationLikeText(value) { return /\b(university|institute|department|laboratory|school|college|hospital)\b|大学|学院|研究所|实验室/i.test(String(value || "")); }
    LitMTransPort.affiliationLikeText = affiliationLikeText;
    function authorBylineLikeText(value) {
        const text = String(value || "").trim();
        return text.length < 260 && /(?:\b[A-Z][a-z]+\s+[A-Z][a-z]+\b|\borcid\b|\*|†|‡)/i.test(text) && !/[.!?。！？]\s*$/.test(text);
    }
    LitMTransPort.authorBylineLikeText = authorBylineLikeText;
    function shouldCheckTranslation(record) { return Boolean(record.sourceText.trim()) && !authorBylineLikeText(record.sourceText) && !affiliationLikeText(record.sourceText); }
    LitMTransPort.shouldCheckTranslation = shouldCheckTranslation;
    function visibleTextLength(value) { return normalizedCompareText(String(value || "").replace(/\$[^$]*\$|\\\[[\s\S]*?\\\]/g, "")).length; }
    LitMTransPort.visibleTextLength = visibleTextLength;
    function looksOverexpanded(record) {
        const source = Math.max(1, visibleTextLength(record.sourceText)), translated = visibleTextLength(record.translatedText);
        return translated > Math.max(120, source * 5.5);
    }
    LitMTransPort.looksOverexpanded = looksOverexpanded;
    function looksUntranslated(record, targetLanguage) {
        if (!record.translatedText.trim())
            return true;
        if (!shouldCheckTranslation(record))
            return false;
        const same = normalizedCompareText(record.sourceText) === normalizedCompareText(record.translatedText);
        if (record.type === "title") {
            return targetExpectsCjk(targetLanguage)
                && latinCount(record.sourceText) >= 4
                && same
                && cjkCount(record.translatedText) < 2;
        }
        if (same)
            return true;
        if (targetExpectsCjk(targetLanguage) && latinCount(record.translatedText) > 50 && cjkCount(record.translatedText) < Math.max(2, latinCount(record.translatedText) / 16))
            return true;
        return false;
    }
    LitMTransPort.looksUntranslated = looksUntranslated;
    function suspiciousDuplicateTranslationRecords(records) {
        const bad = [];
        for (let i = 1; i < records.length; i++) {
            const previous = normalizedCompareText(records[i - 1].translatedText), current = normalizedCompareText(records[i].translatedText);
            if (previous.length > 24 && previous === current && normalizedCompareText(records[i - 1].sourceText) !== normalizedCompareText(records[i].sourceText))
                bad.push(records[i - 1]);
        }
        return bad;
    }
    LitMTransPort.suspiciousDuplicateTranslationRecords = suspiciousDuplicateTranslationRecords;
    function recordsNeedingRetry(records, targetLanguage) {
        const bad = records.filter(record => looksUntranslated(record, targetLanguage) || looksOverexpanded(record) || Boolean(inlineFormulaRetryIssue(record.sourceText, record.translatedText)));
        return [...new Map([...bad, ...suspiciousDuplicateTranslationRecords(records)].map(record => [record.blockID, record])).values()];
    }
    LitMTransPort.recordsNeedingRetry = recordsNeedingRetry;
    function repairRecordTranslation(record) {
        return { ...record, translatedText: repairEquationReferenceTranslation(record.sourceText, neutralizeBrokenInlineTex(normalizeMathComparisonEntities(record.translatedText))).trim() };
    }
    LitMTransPort.repairRecordTranslation = repairRecordTranslation;
    function repairRecordTranslations(records) { return records.map(repairRecordTranslation); }
    LitMTransPort.repairRecordTranslations = repairRecordTranslations;
    function applyFormulaReplacements(document, replacements) {
        let changed = 0;
        for (const formula of document.formulas) {
            const value = normalizeFormulaTex(replacements[formula.id] || "");
            if (value && value !== formula.tex) {
                formula.tex = value;
                changed++;
            }
        }
        return changed;
    }
    LitMTransPort.applyFormulaReplacements = applyFormulaReplacements;
    function buildGlobalGuide(records, targetLanguage) {
        return `Translate all blocks into ${targetLanguage}. Preserve ids, visual layout block boundaries, formulas, citations, names, affiliations and block order. Each block maps to an exact physical layout box; do not complete a split fragment with text from another block, and never migrate or merge content across blocks.`;
    }
    LitMTransPort.buildGlobalGuide = buildGlobalGuide;
    function buildTranslationPrompt(records, targetLanguage, referenceContext = "") {
        return [
            buildGlobalGuide(records, targetLanguage),
            'Return JSON: {"translations":[{"id":"...","text":"..."}]}',
            referenceContext ? `Reference context:\n${referenceContext}` : "",
            `Blocks:\n${JSON.stringify(records.map(blockPayload))}`
        ].filter(Boolean).join("\n\n");
    }
    LitMTransPort.buildTranslationPrompt = buildTranslationPrompt;
    function splitRecords(records, maxChars = 0, maxBlocks = 0) {
        if (maxChars <= 0 && maxBlocks <= 0)
            return records.length ? [[...records]] : [];
        const groups = [];
        let current = [], chars = 0;
        for (const record of records) {
            const overflowChars = maxChars > 0 && current.length && chars + record.sourceText.length > maxChars;
            const overflowBlocks = maxBlocks > 0 && current.length >= maxBlocks;
            if (overflowChars || overflowBlocks) {
                groups.push(current);
                current = [];
                chars = 0;
            }
            current.push(record);
            chars += record.sourceText.length;
        }
        if (current.length)
            groups.push(current);
        return groups;
    }
    LitMTransPort.splitRecords = splitRecords;
})(LitMTransPort || (LitMTransPort = {}));
var LitMTransPort;
(function (LitMTransPort) {
    function messageContentTextParts(content) {
        if (typeof content === "string")
            return [content];
        return (content || []).filter(part => part?.type === "text").map(part => String(part.text || ""));
    }
    LitMTransPort.messageContentTextParts = messageContentTextParts;
    function messageContentToFullText(content) { return messageContentTextParts(content).join("\n").trim(); }
    LitMTransPort.messageContentToFullText = messageContentToFullText;
    function messageContentToDisplayText(content) {
        if (typeof content === "string")
            return content;
        return (content || []).map(part => part.type === "text" ? String(part.text || "") : "[图片]").join("\n").trim();
    }
    LitMTransPort.messageContentToDisplayText = messageContentToDisplayText;
    function normalizeChatMessage(value) {
        const role = value.role === "assistant" || value.role === "system" ? value.role : "user";
        const createdAt = String(value.createdAt || new Date().toISOString());
        return { id: String(value.id || `msg-${createdAt.replace(/\D/g, "")}-${LitMTransPort.shortHash(messageContentToDisplayText(value.content || ""))}`), role, content: value.content || "", createdAt, reasoning: String(value.reasoning || ""), usage: value.usage || null };
    }
    LitMTransPort.normalizeChatMessage = normalizeChatMessage;
    function createChatSession(documentID, fingerprint, title = "新对话", now = new Date()) {
        const timestamp = now.toISOString();
        return { id: `session-${timestamp.replace(/\D/g, "")}-${LitMTransPort.shortHash(documentID + title)}`, documentID, title, sourceFingerprint: fingerprint, createdAt: timestamp, updatedAt: timestamp, messages: [], archivedRevisions: [] };
    }
    LitMTransPort.createChatSession = createChatSession;
    function archiveDocumentRevision(session, previousFingerprint, nextFingerprint) {
        if (!previousFingerprint || previousFingerprint === nextFingerprint || session.sourceFingerprint !== previousFingerprint)
            return { ...session, messages: [...session.messages] };
        return { ...session, sourceFingerprint: nextFingerprint, archivedRevisions: [...new Set([...session.archivedRevisions, previousFingerprint])], updatedAt: new Date().toISOString(), messages: [...session.messages] };
    }
    LitMTransPort.archiveDocumentRevision = archiveDocumentRevision;
    function markdownImageReferences(markdown) {
        return [...String(markdown || "").matchAll(/!\[([^\]]*)\]\(([^)]+)\)/g)].map(match => ({ alt: match[1], target: match[2].trim() }));
    }
    LitMTransPort.markdownImageReferences = markdownImageReferences;
    function buildDocumentContextForMessage(document, question, options = {}) {
        const maxChars = Number(options.maxChars || 0);
        const source = maxChars > 0 ? document.markdown.slice(0, maxChars) : document.markdown;
        const parts = [{ type: "text", text: `Document sourceFingerprint: ${document.sourceFingerprint}\n\n${source}\n\nUser question:\n${String(question || "")}` }];
        if (options.includeImages) {
            for (const reference of markdownImageReferences(source)) {
                const image = document.images.find(item => item.cleanTarget === reference.target || item.originalTarget === reference.target);
                if (!image || image.warning)
                    continue;
                const url = options.resolveImage?.(image.cleanTarget) || "";
                if (url)
                    parts.push({ type: "image_url", image_url: { url } });
            }
        }
        return parts;
    }
    LitMTransPort.buildDocumentContextForMessage = buildDocumentContextForMessage;
    function buildSearchAgentStylesheet() { return ".chat-message{white-space:normal}.chat-message pre{white-space:pre-wrap}.chat-reference{border-left:3px solid currentColor;padding-left:.75rem}"; }
    LitMTransPort.buildSearchAgentStylesheet = buildSearchAgentStylesheet;
    function buildDocumentToolAdapter(adapter) {
        if (!adapter || typeof adapter.parse !== "function")
            throw new LitMTransPort.PortError("HOST_ADAPTER", "文档解析适配器缺少 parse 方法");
        return Object.freeze({
            async parse(path, signal) {
                const source = String(path || "").trim();
                if (!source)
                    throw new LitMTransPort.PortError("INVALID_INPUT", "文档路径为空");
                return adapter.parse(source, signal);
            },
            cancel(reason) { adapter.cancel?.(reason); }
        });
    }
    LitMTransPort.buildDocumentToolAdapter = buildDocumentToolAdapter;
    let documentToolAdapter = null;
    function setDocumentToolAdapter(adapter) { documentToolAdapter = adapter; }
    LitMTransPort.setDocumentToolAdapter = setDocumentToolAdapter;
    function getDocumentToolAdapter() { return documentToolAdapter; }
    LitMTransPort.getDocumentToolAdapter = getDocumentToolAdapter;
    function normalizeAgentConfiguration(config) {
        const provider = LitMTransPort.normalizeProviderID(config.provider || "oneapi");
        return { provider, baseURL: LitMTransPort.normalize_ai_base_url(config.baseURL || LitMTransPort.providerSpec(provider).defaultBaseURL, provider), model: String(config.model || LitMTransPort.providerSpec(provider).defaultModel), enabled: config.enabled !== false };
    }
    function configureResearchAiBase(config) { return normalizeAgentConfiguration(config); }
    LitMTransPort.configureResearchAiBase = configureResearchAiBase;
    function configureSearchAiBase(config) { return normalizeAgentConfiguration(config); }
    LitMTransPort.configureSearchAiBase = configureSearchAiBase;
    function openAiAgentDialog(agent, payload = {}) { return { kind: "open-agent-dialog", agent, payload: { ...payload } }; }
    LitMTransPort.openAiAgentDialog = openAiAgentDialog;
    function openDocumentChat(documentID, fingerprint) { return createChatSession(documentID, fingerprint); }
    LitMTransPort.openDocumentChat = openDocumentChat;
    function installSearchAgentDialogStyleFilter(value) {
        const base = String(value || "").trim();
        return [base, buildSearchAgentStylesheet(), ".agent-dialog{min-width:32rem;max-width:min(72rem,96vw)}"].filter(Boolean).join("\n");
    }
    LitMTransPort.installSearchAgentDialogStyleFilter = installSearchAgentDialogStyleFilter;
})(LitMTransPort || (LitMTransPort = {}));
var LitMTransPort;
(function (LitMTransPort) {
    LitMTransPort.DEFAULT_SETTINGS = Object.freeze({
        translationProvider: "deepseek", translationBaseURL: "", translationModel: "",
        chatProvider: "deepseek", chatBaseURL: "", chatModel: "", targetLanguage: "简体中文", sourceLanguage: "英文", machineSourceLanguage: "英文",
        translationMode: "full_context", chunkChars: 135000, layoutChunkChars: 135000, layoutChunkBlocks: 160,
        layoutReadingMode: true, streamSyncScroll: false, readerFontPt: 12, showReasoning: false, requestAudit: false
    });
    function normalizeSettings(input) {
        return {
            ...LitMTransPort.DEFAULT_SETTINGS, ...input,
            chunkChars: Math.max(10000, Math.min(300000, Number(input.chunkChars ?? LitMTransPort.DEFAULT_SETTINGS.chunkChars) || LitMTransPort.DEFAULT_SETTINGS.chunkChars)),
            layoutChunkChars: Math.max(0, Math.min(300000, Number(input.layoutChunkChars ?? LitMTransPort.DEFAULT_SETTINGS.layoutChunkChars) || 0)),
            layoutChunkBlocks: Math.max(0, Math.min(2000, Number(input.layoutChunkBlocks ?? LitMTransPort.DEFAULT_SETTINGS.layoutChunkBlocks) || 0)),
            readerFontPt: positiveFontSize(input.readerFontPt),
            layoutReadingMode: Boolean(input.layoutReadingMode), streamSyncScroll: Boolean(input.streamSyncScroll),
            showReasoning: Boolean(input.showReasoning), requestAudit: Boolean(input.requestAudit)
        };
    }
    LitMTransPort.normalizeSettings = normalizeSettings;
    function positiveFontSize(value, fallback = LitMTransPort.DEFAULT_SETTINGS.readerFontPt) {
        const fontSize = Number(value);
        return Number.isFinite(fontSize) && fontSize > 0 ? fontSize : fallback;
    }
    function normalizeOneapiRequestBodyMode(value) {
        return String(value || "").toLowerCase().includes("response") ? "responses" : "chat_completions";
    }
    LitMTransPort.normalizeOneapiRequestBodyMode = normalizeOneapiRequestBodyMode;
    function editOneapiRequestBodyMode(value) { return normalizeOneapiRequestBodyMode(value); }
    LitMTransPort.editOneapiRequestBodyMode = editOneapiRequestBodyMode;
    function utf8Bytes(value) { return new TextEncoder().encode(String(value || "")); }
    function utf8Text(value) { return new TextDecoder().decode(value); }
    function requireSecretProtector(protector) {
        if (!protector)
            throw new LitMTransPort.PortError("HOST_ADAPTER", "当前环境无法安全保存密钥，请重启Zotero后重试");
        return protector;
    }
    function protectSecret(value, protector) {
        return requireSecretProtector(protector).protect(utf8Bytes(value));
    }
    LitMTransPort.protectSecret = protectSecret;
    function unprotectSecret(value, protector) {
        return utf8Text(requireSecretProtector(protector).unprotect(new Uint8Array(value)));
    }
    LitMTransPort.unprotectSecret = unprotectSecret;
    function BlobFromBytes(value) { return new Uint8Array(value); }
    LitMTransPort.BlobFromBytes = BlobFromBytes;
    function DpapiProtect(value, protector) {
        return requireSecretProtector(protector).protect(new Uint8Array(value));
    }
    LitMTransPort.DpapiProtect = DpapiProtect;
    function DpapiUnprotect(value, protector) {
        return requireSecretProtector(protector).unprotect(new Uint8Array(value));
    }
    LitMTransPort.DpapiUnprotect = DpapiUnprotect;
    function SettingsFromDict(value) { return normalizeSettings(value); }
    LitMTransPort.SettingsFromDict = SettingsFromDict;
    function loadSettings(store) {
        const values = {};
        for (const key of Object.keys(LitMTransPort.DEFAULT_SETTINGS))
            values[key] = store.get(key, LitMTransPort.DEFAULT_SETTINGS[key]);
        return normalizeSettings(values);
    }
    LitMTransPort.loadSettings = loadSettings;
    function saveSettings(store, values) {
        const normalized = normalizeSettings({ ...loadSettings(store), ...values });
        for (const [key, value] of Object.entries(normalized))
            store.set(key, value);
        return normalized;
    }
    LitMTransPort.saveSettings = saveSettings;
    function secretPath(scope, provider) { return `${LitMTransPort.safe_document_stem(scope, "scope", 32)}/${LitMTransPort.safe_document_stem(provider, "provider", 48)}`; }
    LitMTransPort.secretPath = secretPath;
    function saveSecret(store, scope, provider, value) { store.set(scope, provider, String(value || "").trim()); }
    LitMTransPort.saveSecret = saveSecret;
    function loadSecret(store, scope, provider) { return store.get(scope, provider); }
    LitMTransPort.loadSecret = loadSecret;
    function deleteSecret(store, scope, provider) { store.delete(scope, provider); }
    LitMTransPort.deleteSecret = deleteSecret;
    function getBasePath(root) { return String(root || "").replace(/[\\/]+$/, ""); }
    LitMTransPort.getBasePath = getBasePath;
    function normalizeClasses(classes) { return [...new Set(classes.map(String).map(value => value.trim()).filter(Boolean))]; }
    function applyElevation(value) {
        return { ...value, classes: normalizeClasses([...(value.classes || []), "litmtrans-elevated"]) };
    }
    LitMTransPort.applyElevation = applyElevation;
    function removeElevation(value) {
        return { ...value, classes: normalizeClasses((value.classes || []).filter(name => name !== "litmtrans-elevated")) };
    }
    LitMTransPort.removeElevation = removeElevation;
    function buildDarkPremiumStylesheet() {
        return ":root{color-scheme:dark light;--litmtrans-panel-bg:color-mix(in srgb,Canvas 94%,CanvasText 6%);--litmtrans-border:color-mix(in srgb,CanvasText 18%,transparent)}";
    }
    LitMTransPort.buildDarkPremiumStylesheet = buildDarkPremiumStylesheet;
    function applyMonochromeAppStyle(value) {
        const base = String(value || "").trim();
        const monochrome = ":root{--litmtrans-accent:CanvasText;--litmtrans-muted:GrayText}button,input,select{accent-color:CanvasText}";
        return [base, monochrome].filter(Boolean).join("\n");
    }
    LitMTransPort.applyMonochromeAppStyle = applyMonochromeAppStyle;
    function createSilentMessageBox(message, level = "info") {
        return { message: String(message || ""), native: false, level };
    }
    LitMTransPort.createSilentMessageBox = createSilentMessageBox;
    function configureSilentApplication() {
        return { suppressNativeDialogs: true, notificationMode: "structured" };
    }
    LitMTransPort.configureSilentApplication = configureSilentApplication;
    function showSilentMessage(message) { return createSilentMessageBox(message); }
    LitMTransPort.showSilentMessage = showSilentMessage;
    function makeStaticMessage(message) { return { show: () => createSilentMessageBox(message) }; }
    LitMTransPort.makeStaticMessage = makeStaticMessage;
    function show(message) { return createSilentMessageBox(message); }
    LitMTransPort.show = show;
    function about(message) { return createSilentMessageBox(message); }
    LitMTransPort.about = about;
    function applyGoogleSansCodeFont(value) {
        const stack = '"Google Sans Code","SFMono-Regular",Consolas,"Liberation Mono",monospace';
        const current = String(value || "").trim();
        return current ? `${stack},${current}` : stack;
    }
    LitMTransPort.applyGoogleSansCodeFont = applyGoogleSansCodeFont;
    function installQtWarningFilter() {
        return { ignore: [/QFont::setPixelSize/i, /QPainter::begin/i], report: [/error|failed|exception/i] };
    }
    LitMTransPort.installQtWarningFilter = installQtWarningFilter;
    function messageHandler(message, filter = installQtWarningFilter()) {
        const text = String(message || "");
        return { ignored: filter.ignore.some(pattern => pattern.test(text)) && !filter.report.some(pattern => pattern.test(text)), message: text };
    }
    LitMTransPort.messageHandler = messageHandler;
    function ensureValidApplicationFont(value) {
        const cleaned = String(value || "").replace(/[\u0000-\u001f]/g, "").trim();
        return cleaned || "system-ui";
    }
    LitMTransPort.ensureValidApplicationFont = ensureValidApplicationFont;
    function makeComboPopupOnClick() {
        return { openOnPrimaryClick: true, preserveKeyboardNavigation: true, closeOnSelection: true };
    }
    LitMTransPort.makeComboPopupOnClick = makeComboPopupOnClick;
})(LitMTransPort || (LitMTransPort = {}));
var LitMTransPort;
(function (LitMTransPort) {
    function retryableHttpStatus(status) { return status === 408 || status === 425 || status === 429 || status >= 500; }
    LitMTransPort.retryableHttpStatus = retryableHttpStatus;
    function normalizeUsage(value) {
        const usage = value && typeof value === "object" ? value : {};
        const input = Number(usage.input_tokens ?? usage.total_input_tokens ?? usage.prompt_tokens ?? usage.inputTokenCount ?? 0) || 0;
        const output = Number(usage.output_tokens ?? usage.total_output_tokens ?? usage.completion_tokens ?? usage.outputTokenCount ?? 0) || 0;
        const cached = Number(usage.cached_input_tokens ?? usage.total_cached_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0) || 0;
        const reasoning = Number(usage.reasoning_tokens ?? usage.total_thought_tokens ?? usage.completion_tokens_details?.reasoning_tokens ?? 0) || 0;
        return { inputTokens: input, outputTokens: output, totalTokens: Number(usage.total_tokens ?? usage.totalTokenCount ?? input + output) || input + output, cachedInputTokens: cached, reasoningTokens: reasoning };
    }
    LitMTransPort.normalizeUsage = normalizeUsage;
    function parseSSEFrames(text) {
        const normalized = String(text || "").replace(/\r\n?/g, "\n");
        const frames = [];
        for (const raw of normalized.split(/\n\n+/)) {
            if (!raw.trim())
                continue;
            let event = "message";
            const data = [];
            for (const line of raw.split("\n")) {
                if (line.startsWith("event:"))
                    event = line.slice(6).trim() || "message";
                else if (line.startsWith("data:"))
                    data.push(line.slice(5).trimStart());
            }
            if (data.length)
                frames.push({ event, data: data.join("\n") });
        }
        return frames;
    }
    LitMTransPort.parseSSEFrames = parseSSEFrames;
    function redactRequestAudit(value) {
        if (Array.isArray(value))
            return value.map(redactRequestAudit);
        if (!value || typeof value !== "object")
            return value;
        const output = {};
        for (const [key, item] of Object.entries(value)) {
            output[key] = /api[-_]?key|authorization|token|cookie|secret/i.test(key) ? "[REDACTED]" : redactRequestAudit(item);
        }
        return output;
    }
    LitMTransPort.redactRequestAudit = redactRequestAudit;
    function removeLocalAbsolutePaths(value) {
        // A UNC path must contain both a server and a share component.  Matching
        // every `\\` would also redact TeX row breaks (for example `\\ = …`),
        // corrupting display equations before they reach the model. PDF OCR also
        // occasionally turns URL slashes into backslashes (for example
        // `http:\\\\doi.org\\10.1063/...`); that is a citation URL, not a UNC path.
        const text = String(value || "");
        const protectedURLs = [];
        // Protect complete web links before looking for drive-letter paths. This
        // also covers PDF OCR output such as `http:\\doi.org\10.1063/...`, where
        // the final `p` could otherwise be read as a Windows drive letter.
        const protectedText = text.replace(/https?:[\\/]+[^\s<>'\"]+/gi, match => {
            const token = `__LitMTrans_URL_${protectedURLs.length}__`;
            protectedURLs.push(match);
            return token;
        });
        const redacted = protectedText.replace(/(?:[A-Za-z]:[\\/][^\r\n]*|\\\\[^\s\\/:*?\"<>|]+\\[^\r\n]*)/g, "[本地路径已隐藏]");
        return redacted.replace(/__LitMTrans_URL_(\d+)__/g, (_token, index) => protectedURLs[Number(index)] || "");
    }
    LitMTransPort.removeLocalAbsolutePaths = removeLocalAbsolutePaths;
})(LitMTransPort || (LitMTransPort = {}));
var LitMTransPort;
(function (LitMTransPort) {
    function documentID(input) {
        const base = `${input.libraryID}:${input.itemKey}:${input.attachmentKey}`;
        return `zotero-${LitMTransPort.safe_document_stem(String(input.libraryID), "library", 24)}-${LitMTransPort.safe_document_stem(input.itemKey || input.attachmentKey || LitMTransPort.shortHash(input.filePath), "item", 48)}-${LitMTransPort.shortHash(base)}`;
    }
    LitMTransPort.documentID = documentID;
    function normalizeOriginalPathHint(path) {
        const value = String(path || "").replace(/\\/g, "/");
        return value.slice(value.lastIndexOf("/") + 1);
    }
    LitMTransPort.normalizeOriginalPathHint = normalizeOriginalPathHint;
    function newNormalizedDocument(id, markdown) {
        const document = { schemaVersion: 3, documentID: id, title: "", sourcePathHint: "", markdown: LitMTransPort.cleanMarkdownText(markdown), pages: [], images: [], formulas: [], references: [], sourceFingerprint: "", generatedAt: new Date().toISOString(), metadata: {} };
        document.sourceFingerprint = LitMTransPort.sourceFingerprint(document);
        return document;
    }
    LitMTransPort.newNormalizedDocument = newNormalizedDocument;
    function updateDocumentFingerprint(document) { return { ...document, sourceFingerprint: LitMTransPort.sourceFingerprint(document) }; }
    LitMTransPort.updateDocumentFingerprint = updateDocumentFingerprint;
    function sourceChanged(previous, current) { return Boolean(previous?.sourceFingerprint && previous.sourceFingerprint !== current.sourceFingerprint); }
    LitMTransPort.sourceChanged = sourceChanged;
})(LitMTransPort || (LitMTransPort = {}));
var LitMTransPort;
(function (LitMTransPort) {
    function migrationIdentityKey(identity) {
        return [identity.pythonFile, identity.className, identity.functionName].filter(Boolean).join("::");
    }
    LitMTransPort.migrationIdentityKey = migrationIdentityKey;
    function validateMigrationIdentity(identity) {
        const errors = [];
        if (!identity.pythonFile)
            errors.push("pythonFile");
        if (!identity.functionName && !identity.className)
            errors.push("symbol");
        if (!identity.targetFile)
            errors.push("targetFile");
        if (!identity.status)
            errors.push("status");
        return errors;
    }
    LitMTransPort.validateMigrationIdentity = validateMigrationIdentity;
    function snakeToCamel(value) {
        return String(value || "").replace(/_([a-z0-9])/g, (_match, char) => String(char).toUpperCase()).replace(/^_+/, "");
    }
    LitMTransPort.snakeToCamel = snakeToCamel;
})(LitMTransPort || (LitMTransPort = {}));
var LitMTransPort;
(function (LitMTransPort) {
    function readingModeContract(mode) {
        return mode === "layout"
            ? { mode, sourceKind: "zotero-reader", translationKind: "layout-pages", view: "both", syncScroll: true, swapped: false, sourceSharePercent: 50 }
            : { mode, sourceKind: "parsed-markdown", translationKind: "stream-markdown", view: "both", syncScroll: false, swapped: false, sourceSharePercent: 50 };
    }
    LitMTransPort.readingModeContract = readingModeContract;
    function captureCleanReadingSnapshot(input) {
        const ratio = (top, height, client) => top / Math.max(1, height - client);
        const sourceTop = Number(input.sourceScrollTop || 0), translationTop = Number(input.translationScrollTop || 0);
        return {
            active: true, mode: input.mode === "layout" ? "layout" : "stream",
            readerView: ["source", "translation"].includes(String(input.readerView)) ? input.readerView : "both",
            swapped: Boolean(input.swapped), sourceSharePercent: Math.max(22, Math.min(78, Number(input.sourceSharePercent || 50))),
            sourceScrollTop: sourceTop, translationScrollTop: translationTop,
            sourceScrollRatio: Number.isFinite(Number(input.sourceScrollRatio)) ? Number(input.sourceScrollRatio) : ratio(sourceTop, 1, 0),
            translationScrollRatio: Number.isFinite(Number(input.translationScrollRatio)) ? Number(input.translationScrollRatio) : ratio(translationTop, 1, 0),
            focusedElementID: String(input.focusedElementID || ""), logDrawerOpen: Boolean(input.logDrawerOpen),
            chatRailVisible: Boolean(input.chatRailVisible), enteredAt: Number(input.enteredAt || Date.now())
        };
    }
    LitMTransPort.captureCleanReadingSnapshot = captureCleanReadingSnapshot;
    function exitCleanReadingSnapshot(snapshot) { return { ...snapshot, active: false }; }
    LitMTransPort.exitCleanReadingSnapshot = exitCleanReadingSnapshot;
    function validateReaderModeState(state) {
        const errors = [];
        if (state.mode === "stream" && state.sourceKind !== "parsed-markdown")
            errors.push("流式模式原文必须为MinerU解析原文");
        if (state.mode === "layout" && state.sourceKind !== "zotero-reader")
            errors.push("排版模式原文必须为Zotero Reader原始PDF");
        if (state.mode === "layout" && state.translationKind !== "layout-pages")
            errors.push("排版模式译文必须为排版译文");
        return errors;
    }
    LitMTransPort.validateReaderModeState = validateReaderModeState;
})(LitMTransPort || (LitMTransPort = {}));
var LitMTransPort;
(function (LitMTransPort) {
    function planZipExtraction(entries, options = {}) {
        const maxFiles = Math.max(1, Number(options.maxFiles || 20000));
        const maxBytes = Math.max(1, Number(options.maxUncompressedBytes || 4 * 1024 * 1024 * 1024));
        const files = entries.filter(entry => !entry.directory);
        if (files.length > maxFiles)
            throw new LitMTransPort.PortError("INVALID_ZIP", `ZIP文件数量超过限制: ${files.length}`);
        const total = files.reduce((sum, entry) => sum + Math.max(0, Number(entry.uncompressedSize || 0)), 0);
        if (total > maxBytes)
            throw new LitMTransPort.PortError("INVALID_ZIP", `ZIP解压后体积超过限制: ${total}`);
        const normalized = files.map(entry => ({ ...entry, sourceName: entry.name, relativePath: LitMTransPort.normalizeRelativePath(entry.name) }));
        const prefix = LitMTransPort.commonDirectoryPrefix(normalized.map(entry => entry.relativePath));
        const stripPrefix = prefix && normalized.every(entry => entry.relativePath.startsWith(prefix + "/")) ? prefix + "/" : "";
        const used = new Set();
        return normalized.map(entry => {
            const relative = stripPrefix ? entry.relativePath.slice(stripPrefix.length) : entry.relativePath;
            const shortened = LitMTransPort.shortenWindowsPath(relative, Number(options.windowsMaxPath || 220));
            return { ...entry, relativePath: LitMTransPort.deduplicateRelativePath(shortened, used) };
        });
    }
    LitMTransPort.planZipExtraction = planZipExtraction;
    function identifyMinerURoot(paths) {
        const normalized = paths.map(path => LitMTransPort.normalizeRelativePath(path));
        const scores = new Map();
        for (const path of normalized) {
            const parts = path.split("/");
            for (let depth = 0; depth < parts.length; depth++) {
                const dir = parts.slice(0, depth).join("/");
                const name = parts[parts.length - 1].toLowerCase();
                let score = scores.get(dir) || 0;
                if (name.endsWith(".md"))
                    score += 10;
                if (/(?:model|content|middle|layout).*\.json$/.test(name))
                    score += 8;
                if (/images?\//i.test(path))
                    score += 2;
                scores.set(dir, score);
            }
        }
        return [...scores.entries()].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)[0]?.[0] || "";
    }
    LitMTransPort.identifyMinerURoot = identifyMinerURoot;
})(LitMTransPort || (LitMTransPort = {}));
var LitMTransPort;
(function (LitMTransPort) {
    function normalizeAssetKey(value) {
        return String(value || "").normalize("NFC").replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/{2,}/g, "/").replace(/^\//, "");
    }
    LitMTransPort.normalizeAssetKey = normalizeAssetKey;
    function assetBasename(value) { const normalized = normalizeAssetKey(value); return normalized.slice(normalized.lastIndexOf("/") + 1); }
    LitMTransPort.assetBasename = assetBasename;
    function localMarkdownImageTargets(markdown) {
        return [...new Set(LitMTransPort.markdownImageReferences(markdown).map(item => normalizeAssetKey(item.target)).filter(target => target && !/^(?:data|https?|resource|file|chrome):/i.test(target)))];
    }
    LitMTransPort.localMarkdownImageTargets = localMarkdownImageTargets;
    function extensionFromTarget(target) {
        const match = assetBasename(target).match(/(\.[A-Za-z0-9]{1,8})(?:[?#].*)?$/);
        return match ? match[1].toLowerCase() : "";
    }
    LitMTransPort.extensionFromTarget = extensionFromTarget;
    function standardizeAssets(markdown, availablePaths) {
        const byKey = new Map();
        for (const path of availablePaths) {
            const key = normalizeAssetKey(path);
            byKey.set(key.toLowerCase(), path);
            byKey.set(assetBasename(key).toLowerCase(), path);
        }
        const imageMap = [], missing = [];
        const used = new Set();
        const output = LitMTransPort.normalizeMarkdownImageTargets(markdown, target => {
            if (/^(?:data|https?|resource|file|chrome):/i.test(target))
                return target;
            const normalized = normalizeAssetKey(target);
            const source = byKey.get(normalized.toLowerCase()) || byKey.get(assetBasename(normalized).toLowerCase()) || "";
            const extension = extensionFromTarget(source || normalized) || ".bin";
            const clean = LitMTransPort.deduplicateRelativePath(`images/${LitMTransPort.safe_document_stem(assetBasename(normalized).replace(/\.[^.]+$/, ""), "image", 72)}${extension}`, used);
            const warning = source ? "" : `解析结果中未找到图片：${target}`;
            imageMap.push({ id: `image-${String(imageMap.length + 1).padStart(4, "0")}`, originalTarget: normalized, cleanTarget: clean, page: null, bbox: null, mimeType: "", warning });
            if (warning)
                missing.push(normalized);
            return clean;
        });
        return { markdown: output, imageMap, missing };
    }
    LitMTransPort.standardizeAssets = standardizeAssets;
})(LitMTransPort || (LitMTransPort = {}));
var LitMTransPort;
(function (LitMTransPort) {
    function short_upload_filename(path) {
        const ext = LitMTransPort.inputExtension(path);
        const clean = LitMTransPort.safe_document_stem(LitMTransPort.normalizeOriginalPathHint(path).replace(/\.[^.]+$/, ""), "document", 48);
        return `${clean}-${LitMTransPort.shortHash(path)}${ext}`;
    }
    LitMTransPort.short_upload_filename = short_upload_filename;
    function temporary_mineru_upload_file(path) { return { originalPath: path, uploadName: short_upload_filename(path) }; }
    LitMTransPort.temporary_mineru_upload_file = temporary_mineru_upload_file;
    function mineruIsSupportedInputFile(path) { return LitMTransPort.is_supported_input_file(path) && !LitMTransPort.is_direct_text_input_file(path); }
    LitMTransPort.mineruIsSupportedInputFile = mineruIsSupportedInputFile;
    function buildMinerUSubmitPayload(filename, options) {
        return { files: [{ name: filename, data_id: LitMTransPort.shortHash(filename) }], model_version: options.modelVersion || "vlm", is_ocr: Boolean(options.isOCR), enable_table: Boolean(options.enableTable), enable_formula: Boolean(options.enableFormula) };
    }
    LitMTransPort.buildMinerUSubmitPayload = buildMinerUSubmitPayload;
    function normalizeMinerUTask(value) {
        const data = value && typeof value === "object" ? value : {};
        const nested = (data.data && typeof data.data === "object" ? data.data : data);
        const item = Array.isArray(nested.extract_result) ? (nested.extract_result[0] || {}) : nested;
        return {
            batchID: String(nested.batch_id || nested.batchID || item.batch_id || ""),
            status: String(item.state || item.status || nested.state || nested.status || "").toLowerCase(),
            resultURL: String(item.full_zip_url || item.result_url || item.url || ""),
            error: String(item.err_msg || item.error || nested.err_msg || nested.error || ""),
            progress: Math.max(0, Math.min(100, Number(item.progress || nested.progress || 0)))
        };
    }
    LitMTransPort.normalizeMinerUTask = normalizeMinerUTask;
    async function submitMinerUTask(adapter, filename, options, signal = null) {
        LitMTransPort.throwIfAborted(signal);
        return adapter.http.requestJSON("POST", `${adapter.apiBase.replace(/\/$/, "")}/file-urls/batch`, { headers: { Authorization: `Bearer ${adapter.token}` }, json: buildMinerUSubmitPayload(filename, options), signal });
    }
    LitMTransPort.submitMinerUTask = submitMinerUTask;
    async function pollMinerUTask(adapter, batchID, options = {}) {
        const attempts = Math.max(1, Number(options.attempts || 180));
        for (let attempt = 1; attempt <= attempts; attempt++) {
            LitMTransPort.throwIfAborted(options.signal);
            const raw = await adapter.http.requestJSON("GET", `${adapter.apiBase.replace(/\/$/, "")}/extract-results/batch/${encodeURIComponent(batchID)}`, { headers: { Authorization: `Bearer ${adapter.token}` }, signal: options.signal });
            const task = normalizeMinerUTask(raw);
            options.onProgress?.({ stage: "mineru-poll", message: `MinerU: ${task.status || "processing"}`, current: attempt, total: attempts, percent: task.progress || null, detail: { batchID } });
            if (["done", "success", "completed"].includes(task.status) && task.resultURL)
                return task;
            if (["failed", "error", "cancelled"].includes(task.status))
                throw new LitMTransPort.PortError("PARSE_FAILED", task.error || `文献解析失败：${task.status}`);
            await LitMTransPort.cancellableSleep(Number(options.intervalMs || 2000), options.signal);
        }
        throw new LitMTransPort.PortError("PARSE_FAILED", "文献解析服务响应超时，请稍后重试", { retryable: true, detail: { batchID } });
    }
    LitMTransPort.pollMinerUTask = pollMinerUTask;
    function saveMineruToken(store, value) { LitMTransPort.saveSecret(store, "mineru", "official", value); }
    LitMTransPort.saveMineruToken = saveMineruToken;
    function loadMineruToken(store) { return LitMTransPort.loadSecret(store, "mineru", "official"); }
    LitMTransPort.loadMineruToken = loadMineruToken;
    function buildMineruDocumentToolAdapter(adapter) {
        const required = [
            "isConfigured", "saveKey", "isSupportedInputFile", "createOutputDirectory", "parse",
            "latestTranslationPath", "findStoredOriginal", "createReaderWindow"
        ];
        for (const key of required) {
            if (typeof adapter?.[key] !== "function")
                throw new LitMTransPort.PortError("HOST_ADAPTER", `MinerU文档工具适配器缺少 ${String(key)} 方法`);
        }
        return Object.freeze({
            isConfigured: () => Boolean(adapter.isConfigured()),
            saveKey: (token) => adapter.saveKey(String(token || "").trim()),
            isSupportedInputFile: (path) => Boolean(adapter.isSupportedInputFile(String(path || ""))),
            createOutputDirectory: (documentID) => adapter.createOutputDirectory(String(documentID || "")),
            parse: (inputPath, outputDirectory, context) => {
                context.check();
                return adapter.parse(String(inputPath || ""), String(outputDirectory || ""), context);
            },
            latestTranslationPath: (documentID) => adapter.latestTranslationPath(String(documentID || "")),
            findStoredOriginal: (documentID) => adapter.findStoredOriginal(String(documentID || "")),
            createReaderWindow: (mode) => Object.freeze({ ...adapter.createReaderWindow(mode) })
        });
    }
    LitMTransPort.buildMineruDocumentToolAdapter = buildMineruDocumentToolAdapter;
    function createParseWorker(adapter, inputPath, outputDirectory, onProgress = null) {
        const controller = new AbortController();
        const context = new LitMTransPort.TaskContext(`mineru-${LitMTransPort.shortHash(inputPath)}`, controller.signal, onProgress);
        let running = null;
        return Object.freeze({
            context,
            run() {
                if (!running)
                    running = LitMTransPort.runTask(context, current => adapter.parse(inputPath, outputDirectory, current));
                return running;
            },
            requestStop(reason = "已取消解析") { if (!controller.signal.aborted)
                controller.abort(reason); },
            isCancelled() { return controller.signal.aborted; }
        });
    }
    LitMTransPort.createParseWorker = createParseWorker;
})(LitMTransPort || (LitMTransPort = {}));
var LitMTransPort;
(function (LitMTransPort) {
    LitMTransPort.PROVIDER_SPECS = Object.freeze({
        free_machine: { id: "free_machine", name: "联网免费机翻", protocol: "openai-chat", defaultBaseURL: "", defaultModel: "", supportsReasoning: false, supportsImages: false, supportsChat: false, textModelFilter: /$^/ },
        edge_local: { id: "edge_local", name: "Edge本地翻译", protocol: "openai-chat", defaultBaseURL: "", defaultModel: "", supportsReasoning: false, supportsImages: false, supportsChat: false, textModelFilter: /$^/ },
        deepseek: { id: "deepseek", name: "DeepSeek", protocol: "openai-chat", defaultBaseURL: "https://api.deepseek.com", defaultModel: "deepseek-chat", supportsReasoning: true, supportsImages: false, supportsChat: true, textModelFilter: /deepseek-(?:chat|reasoner)/i },
        oneapi: { id: "oneapi", name: "OpenAI兼容", protocol: "openai-chat", defaultBaseURL: "", defaultModel: "", supportsReasoning: true, supportsImages: true, supportsChat: true, textModelFilter: /./ },
        openai_compatible: { id: "openai_compatible", name: "OpenAI 兼容接口", protocol: "openai-chat", defaultBaseURL: "", defaultModel: "", supportsReasoning: true, supportsImages: true, supportsChat: true, textModelFilter: /./ },
        gemini: { id: "gemini", name: "Google Gemini", protocol: "gemini-interactions", defaultBaseURL: "https://generativelanguage.googleapis.com/v1beta", defaultModel: "gemini-3.5-flash", supportsReasoning: true, supportsImages: true, supportsChat: true, textModelFilter: /gemini/i },
        siliconflow: { id: "siliconflow", name: "SiliconFlow", protocol: "openai-chat", defaultBaseURL: "https://api.siliconflow.cn/v1", defaultModel: "", supportsReasoning: true, supportsImages: false, supportsChat: true, textModelFilter: /./ },
        zai: { id: "zai", name: "Z.ai", protocol: "openai-chat", defaultBaseURL: "https://open.bigmodel.cn/api/paas/v4", defaultModel: "", supportsReasoning: true, supportsImages: false, supportsChat: true, textModelFilter: /./ },
        openrouter: { id: "openrouter", name: "OpenRouter", protocol: "openai-chat", defaultBaseURL: "https://openrouter.ai/api/v1", defaultModel: "", supportsReasoning: true, supportsImages: true, supportsChat: true, textModelFilter: /./ }
    });
    const PROVIDER_ALIASES = Object.freeze({
        google_free: "free_machine",
        bing_free: "free_machine",
        machine_translate: "free_machine"
    });
    function normalizeProviderID(value) {
        const requested = String(value || "oneapi").trim().toLowerCase();
        const id = PROVIDER_ALIASES[requested]
            || (requested.endsWith("_web") ? "free_machine" : requested);
        return LitMTransPort.PROVIDER_SPECS[id] ? id : "oneapi";
    }
    LitMTransPort.normalizeProviderID = normalizeProviderID;
    function providerSpec(value) { return LitMTransPort.PROVIDER_SPECS[normalizeProviderID(value)]; }
    LitMTransPort.providerSpec = providerSpec;
    function normalize_ai_base_url(value, provider = "oneapi") {
        const spec = providerSpec(provider);
        let url = String(value || spec.defaultBaseURL || "").trim().replace(/\/+$/, "");
        if (spec.protocol === "gemini-interactions")
            url = url.replace(/\/v1beta\/openai$/i, "/v1beta").replace(/\/v1\/openai$/i, "/v1beta").replace(/\/openai$/i, "");
        return url;
    }
    LitMTransPort.normalize_ai_base_url = normalize_ai_base_url;
    function normalize_gemini_model_id(value) { return String(value || "").trim().replace(/^models\//i, ""); }
    LitMTransPort.normalize_gemini_model_id = normalize_gemini_model_id;
    function is_gemini_provider(provider, baseURL = "") { return normalizeProviderID(provider) === "gemini" || /generativelanguage\.googleapis\.com/i.test(baseURL); }
    LitMTransPort.is_gemini_provider = is_gemini_provider;
    function gemini_translation_thinking_config(mode, effort, model = "") {
        const normalizedMode = String(mode || "default").toLowerCase();
        const normalizedEffort = String(effort || "default").toLowerCase();
        const normalizedModel = normalize_gemini_model_id(model).toLowerCase();
        if (normalizedModel.startsWith("gemini-2.5-")) {
            if (normalizedMode === "disabled" && !normalizedModel.includes("2.5-pro"))
                return { thinking_budget: 0 };
            const budgets = { minimal: 1024, low: 1024, medium: 8192, high: 24576 };
            return normalizedEffort !== "default" ? { thinking_budget: budgets[normalizedEffort] || 8192 } : {};
        }
        if (normalizedMode === "disabled")
            return { thinking_level: "none" };
        const levels = { minimal: "minimal", low: "low", medium: "medium", high: "high", none: "none" };
        let level = levels[normalizedEffort] || "";
        if (normalizedModel.includes("3.1-pro") && level === "minimal")
            level = "low";
        return level ? { thinking_level: level } : {};
    }
    LitMTransPort.gemini_translation_thinking_config = gemini_translation_thinking_config;
    function parseProviders(value) {
        const output = { ...LitMTransPort.PROVIDER_SPECS };
        if (!value || typeof value !== "object" || Array.isArray(value))
            return output;
        for (const [id, raw] of Object.entries(value)) {
            if (!raw || typeof raw !== "object")
                continue;
            const base = providerSpec(id);
            const item = raw;
            output[id] = { ...base, ...item, id, textModelFilter: base.textModelFilter };
        }
        return output;
    }
    LitMTransPort.parseProviders = parseProviders;
})(LitMTransPort || (LitMTransPort = {}));
var LitMTransPort;
(function (LitMTransPort) {
    function normalizeModelRecord(value) {
        const raw = typeof value === "string" ? { id: value } : value && typeof value === "object" ? value : {};
        const id = LitMTransPort.normalize_gemini_model_id(String(raw.id || raw.name || raw.model || ""));
        const list = (item) => Array.isArray(item) ? item.map(String) : [];
        return { id, name: id, displayName: String(raw.displayName || raw.display_name || id), description: String(raw.description || ""), supportedActions: list(raw.supportedActions || raw.supported_actions || raw.supportedGenerationMethods), inputModalities: list(raw.inputModalities || raw.input_modalities), outputModalities: list(raw.outputModalities || raw.output_modalities) };
    }
    LitMTransPort.normalizeModelRecord = normalizeModelRecord;
    function isTextGenerationModel(value, provider = "oneapi") {
        const model = normalizeModelRecord(value);
        const id = model.id.toLowerCase();
        if (!id)
            return false;
        if (/(?:embedding|embed-|imagen|veo|lyria|tts|speech|audio|live|robotics|aqa|rerank|moderation)/i.test(id))
            return false;
        if (model.outputModalities.length && !model.outputModalities.some(item => /text/i.test(item)))
            return false;
        if (model.supportedActions.length && !model.supportedActions.some(item => /generate|interact|chat|predict/i.test(item)))
            return false;
        return LitMTransPort.providerSpec(provider).textModelFilter.test(model.id);
    }
    LitMTransPort.isTextGenerationModel = isTextGenerationModel;
    function filterTextModels(values, provider) {
        return [...new Map(values.map(normalizeModelRecord).filter(model => isTextGenerationModel(model, provider)).map(model => [model.id, model])).values()].sort((a, b) => a.id.localeCompare(b.id));
    }
    LitMTransPort.filterTextModels = filterTextModels;
    function chooseTranslationModel(provider, models, current = "") {
        const filtered = filterTextModels(models, provider).map(model => model.id);
        if (current && filtered.includes(LitMTransPort.normalize_gemini_model_id(current)))
            return LitMTransPort.normalize_gemini_model_id(current);
        const preferred = [LitMTransPort.providerSpec(provider).defaultModel, "gemini-3.5-flash", "gemini-3.1-flash-lite", "gemini-2.5-flash", "deepseek-chat", "gpt-4.1-mini"].filter(Boolean);
        return preferred.find(model => filtered.includes(model)) || filtered[0] || "";
    }
    LitMTransPort.chooseTranslationModel = chooseTranslationModel;
    function chooseChatModel(models, current = "", provider = "oneapi") { return chooseTranslationModel(provider, models, current); }
    LitMTransPort.chooseChatModel = chooseChatModel;
})(LitMTransPort || (LitMTransPort = {}));
var LitMTransPort;
(function (LitMTransPort) {
    function normalizeLLMConfig(value) {
        const provider = LitMTransPort.normalizeProviderID(value.provider || "deepseek");
        const spec = LitMTransPort.providerSpec(provider);
        return { purpose: value.purpose === "chat" ? "chat" : "translation", provider, protocol: spec.protocol, baseURL: LitMTransPort.normalize_ai_base_url(value.baseURL || spec.defaultBaseURL, provider), model: provider === "gemini" ? LitMTransPort.normalize_gemini_model_id(value.model || spec.defaultModel) : String(value.model || spec.defaultModel), apiKey: String(value.apiKey || "").trim(), thinkingMode: String(value.thinkingMode || "default"), reasoningEffort: String(value.reasoningEffort || "default"), showReasoning: Boolean(value.showReasoning), promptCacheKey: String(value.promptCacheKey || "") };
    }
    LitMTransPort.normalizeLLMConfig = normalizeLLMConfig;
    function assertLLMConfig(config) {
        if (!config.baseURL)
            throw new LitMTransPort.PortError("PROVIDER_CONFIGURATION", "请先在LitMTrans设置中填写API地址");
        if (!config.apiKey)
            throw new LitMTransPort.PortError("PROVIDER_CONFIGURATION", `请先配置${LitMTransPort.providerSpec(config.provider).name}的API密钥`);
        if (!config.model)
            throw new LitMTransPort.PortError("PROVIDER_CONFIGURATION", "请先选择模型");
    }
    LitMTransPort.assertLLMConfig = assertLLMConfig;
})(LitMTransPort || (LitMTransPort = {}));
var LitMTransPort;
(function (LitMTransPort) {
    function sanitizeContentForAPI(content) {
        if (typeof content === "string")
            return LitMTransPort.removeLocalAbsolutePaths(content);
        if (Array.isArray(content))
            return content.map(sanitizeContentForAPI);
        if (!content || typeof content !== "object")
            return content;
        const output = {};
        for (const [key, value] of Object.entries(content))
            output[key] = ["text", "content", "caption", "alt"].includes(key.toLowerCase()) ? sanitizeContentForAPI(value) : value;
        return output;
    }
    LitMTransPort.sanitizeContentForAPI = sanitizeContentForAPI;
    function buildOpenAIChatPayload(config, messages, options = {}) {
        const payload = { model: config.model, messages: messages.map(message => ({ role: String(message.role || "user"), content: sanitizeContentForAPI(message.content) })), stream: options.stream !== false };
        if (options.temperature !== null && options.temperature !== undefined)
            payload.temperature = Number(options.temperature);
        if (Number(options.maxTokens) > 0)
            payload.max_tokens = Number(options.maxTokens);
        if (options.responseFormat === "json_object")
            payload.response_format = { type: "json_object" };
        if (config.promptCacheKey)
            payload.prompt_cache_key = config.promptCacheKey;
        const effort = String(config.reasoningEffort || "default").toLowerCase();
        if (effort !== "default")
            payload.reasoning_effort = effort;
        return payload;
    }
    LitMTransPort.buildOpenAIChatPayload = buildOpenAIChatPayload;
    function buildAnthropicMessagesPayload(config, messages, options = {}) {
        const system = messages.filter(message => message.role === "system").map(message => String(message.content || "")).join("\n\n");
        return { model: config.model, system, messages: messages.filter(message => message.role !== "system").map(message => ({ role: message.role === "assistant" ? "assistant" : "user", content: sanitizeContentForAPI(message.content) })), stream: options.stream !== false, max_tokens: Number(options.maxTokens || 8192) };
    }
    LitMTransPort.buildAnthropicMessagesPayload = buildAnthropicMessagesPayload;
})(LitMTransPort || (LitMTransPort = {}));
var LitMTransPort;
(function (LitMTransPort) {
    function geminiContentParts(content) {
        if (typeof content === "string")
            return [{ type: "text", text: LitMTransPort.sanitizeContentForAPI(content) }];
        if (!Array.isArray(content))
            return [{ type: "text", text: String(content || "") }];
        const parts = [];
        for (const item of content) {
            if (typeof item === "string")
                parts.push({ type: "text", text: LitMTransPort.sanitizeContentForAPI(item) });
            else if (item && typeof item === "object") {
                const value = item;
                const type = String(value.type || "");
                if (type === "text")
                    parts.push({ type: "text", text: LitMTransPort.sanitizeContentForAPI(value.text || "") });
                else if (type === "image_url") {
                    const imageURL = value.image_url;
                    const url = typeof imageURL === "string" ? imageURL : String((imageURL && typeof imageURL === "object" ? imageURL : {}).url || "");
                    const match = url.match(/^data:([^;,]+);base64,(.+)$/s);
                    if (match)
                        parts.push({ type: "image", mime_type: match[1], data: match[2] });
                    else if (url)
                        parts.push({ type: "image", uri: url });
                }
            }
        }
        return parts.length ? parts : [{ type: "text", text: "" }];
    }
    function geminiInteractionInput(messages) {
        const conversation = messages
            .filter(message => String(message.role || "user") !== "system");
        // The Interactions API represents a single user turn as a flat list of
        // content blocks. Timeline steps are only needed when replaying history.
        // Wrapping first-turn image blocks in user_input.content can leave the
        // service waiting indefinitely instead of returning a schema error.
        if (conversation.length === 1
            && String(conversation[0].role || "user") !== "assistant") {
            return geminiContentParts(conversation[0].content);
        }
        return conversation.map(message => ({
            type: String(message.role || "user") === "assistant" ? "model_output" : "user_input",
            content: geminiContentParts(message.content)
        }));
    }
    function buildGeminiInteractionRequest(config, messages, options = {}) {
        const system = messages
            .filter(message => message.role === "system")
            .map(message => String(message.content || ""))
            .join("\n\n")
            .trim();
        const input = geminiInteractionInput(messages);
        const generationConfig = {
            ...LitMTransPort.gemini_translation_thinking_config(config.thinkingMode, config.reasoningEffort, config.model)
        };
        if (config.showReasoning)
            generationConfig.thinking_summaries = "auto";
        if (options.temperature !== null && options.temperature !== undefined)
            generationConfig.temperature = Number(options.temperature);
        if (Number(options.maxTokens) > 0)
            generationConfig.max_output_tokens = Number(options.maxTokens);
        const payload = {
            model: LitMTransPort.normalize_gemini_model_id(config.model),
            input: input.length ? input : "",
            store: false,
            stream: options.stream !== false
        };
        if (system)
            payload.system_instruction = system;
        if (Object.keys(generationConfig).length)
            payload.generation_config = generationConfig;
        if (options.responseFormat === "json_object") {
            payload.response_format = { type: "text", mime_type: "application/json" };
        }
        return payload;
    }
    LitMTransPort.buildGeminiInteractionRequest = buildGeminiInteractionRequest;
    function geminiDeltaText(delta) {
        if (typeof delta.text === "string")
            return delta.text;
        const content = delta.content;
        if (typeof content === "string")
            return content;
        if (content && typeof content === "object") {
            const object = content;
            if (typeof object.text === "string")
                return object.text;
        }
        return "";
    }
    function parseGeminiInteractionEvent(value) {
        const event = value && typeof value === "object" ? value : {};
        const type = String(event.event_type || event.type || "");
        const delta = event.delta && typeof event.delta === "object" ? event.delta : {};
        let text = "", reasoning = "", usage = null, model = "", error = "", done = false;
        if (type === "step.delta" || type.endsWith(".delta")) {
            const deltaType = String(delta.type || event.delta_type || "");
            const valueText = geminiDeltaText(delta) || String(event.text || "");
            if (/thought_summary|thought|reason/i.test(deltaType))
                reasoning = valueText;
            else if (/text|output/i.test(deltaType) || valueText)
                text = valueText;
        }
        const interaction = event.interaction && typeof event.interaction === "object" ? event.interaction : event;
        if (/completed|done/i.test(type)) {
            done = true;
            model = String(interaction.model || event.model || "");
            if (interaction.usage || event.usage)
                usage = LitMTransPort.normalizeUsage(interaction.usage || event.usage);
            if (!text)
                text = extractGeminiInteractionText(interaction);
            if (!reasoning)
                reasoning = extractGeminiThoughtSummary(interaction);
        }
        if (/error|failed/i.test(type) || event.error) {
            const raw = event.error && typeof event.error === "object" ? event.error : event;
            error = String(raw.message || raw.status || "Gemini Interactions API返回错误");
            done = true;
        }
        return { text, reasoning, usage, model, done, error };
    }
    LitMTransPort.parseGeminiInteractionEvent = parseGeminiInteractionEvent;
    function extractGeminiInteractionText(value) {
        const root = value && typeof value === "object" ? value : {};
        if (typeof root.output_text === "string")
            return root.output_text;
        const pieces = [];
        const visit = (item, reasoning = false) => {
            if (typeof item === "string") {
                if (!reasoning)
                    pieces.push(item);
                return;
            }
            if (Array.isArray(item)) {
                item.forEach(value => visit(value, reasoning));
                return;
            }
            if (!item || typeof item !== "object")
                return;
            const object = item;
            const type = String(object.type || "").toLowerCase();
            const nextReasoning = reasoning || /thought|reason/.test(type);
            if (!nextReasoning && type === "text" && typeof object.text === "string")
                pieces.push(object.text);
            for (const key of ["steps", "outputs", "output", "content", "parts"]) {
                if (object[key] !== undefined)
                    visit(object[key], nextReasoning);
            }
        };
        visit(root.steps || root.output || root.outputs || []);
        return pieces.join("").trim();
    }
    LitMTransPort.extractGeminiInteractionText = extractGeminiInteractionText;
    function extractGeminiThoughtSummary(value) {
        const root = value && typeof value === "object" ? value : {};
        const pieces = [];
        const visit = (item, thought = false) => {
            if (typeof item === "string") {
                if (thought)
                    pieces.push(item);
                return;
            }
            if (Array.isArray(item)) {
                item.forEach(value => visit(value, thought));
                return;
            }
            if (!item || typeof item !== "object")
                return;
            const object = item;
            const type = String(object.type || "").toLowerCase();
            const next = thought || /thought_summary|thought|reason/.test(type);
            if (next && type === "text" && typeof object.text === "string")
                pieces.push(object.text);
            for (const key of ["steps", "outputs", "output", "summary", "content", "parts", "thought_summary"]) {
                if (object[key] !== undefined)
                    visit(object[key], next || key === "summary" || key === "thought_summary");
            }
        };
        visit(root);
        return pieces.join("").trim();
    }
    LitMTransPort.extractGeminiThoughtSummary = extractGeminiThoughtSummary;
    function geminiInteractionsURL(baseURL, stream = true) {
        const base = LitMTransPort.normalize_ai_base_url(baseURL, "gemini").replace(/\/$/, "");
        return `${base}/interactions${stream ? "?alt=sse" : ""}`;
    }
    LitMTransPort.geminiInteractionsURL = geminiInteractionsURL;
    function geminiModelsURL(baseURL) {
        const base = LitMTransPort.normalize_ai_base_url(baseURL, "gemini").replace(/\/(?:v1|v1beta)$/, "");
        return `${base}/v1beta/models`;
    }
    LitMTransPort.geminiModelsURL = geminiModelsURL;
})(LitMTransPort || (LitMTransPort = {}));
var LitMTransPort;
(function (LitMTransPort) {
    function normalizeCompletionResult(value) {
        return { text: String(value.text || "").trim(), reasoning: String(value.reasoning || ""), usage: value.usage || null, model: String(value.model || ""), terminalState: value.terminalState || "completed" };
    }
    LitMTransPort.normalizeCompletionResult = normalizeCompletionResult;
    function mergeUsage(left, right) {
        if (!left)
            return right ? { ...right } : null;
        if (!right)
            return { ...left };
        return { inputTokens: left.inputTokens + right.inputTokens, outputTokens: left.outputTokens + right.outputTokens, totalTokens: left.totalTokens + right.totalTokens, cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens, reasoningTokens: left.reasoningTokens + right.reasoningTokens };
    }
    LitMTransPort.mergeUsage = mergeUsage;
    function normalizeProviderError(error, provider) {
        const normalized = LitMTransPort.normalizePortError(error, "MODEL_PROTOCOL");
        return new LitMTransPort.PortError(normalized.code, `${LitMTransPort.providerSpec(provider).name}: ${normalized.message}`, { retryable: normalized.retryable, detail: { ...normalized.detail, provider }, cause: error });
    }
    LitMTransPort.normalizeProviderError = normalizeProviderError;
})(LitMTransPort || (LitMTransPort = {}));
var LitMTransPort;
(function (LitMTransPort) {
    function detectImageMimeType(bytes, fallback = "image/png") {
        if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)
            return "image/png";
        if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
            return "image/jpeg";
        if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP")
            return "image/webp";
        if (bytes.length >= 6 && String.fromCharCode(...bytes.slice(0, 3)) === "GIF")
            return "image/gif";
        if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d)
            return "image/bmp";
        return fallback;
    }
    LitMTransPort.detectImageMimeType = detectImageMimeType;
    function isProbablyImageModel(model) { return /(?:image|imagen|dall-e|gpt-image|flux|stable-diffusion)/i.test(String(model || "")); }
    LitMTransPort.isProbablyImageModel = isProbablyImageModel;
})(LitMTransPort || (LitMTransPort = {}));
var LitMTransPort;
(function (LitMTransPort) {
    function providerEndpoint(config, operation) {
        if (config.protocol === "gemini-interactions")
            return operation === "models" ? LitMTransPort.geminiModelsURL(config.baseURL) : LitMTransPort.geminiInteractionsURL(config.baseURL, true);
        return `${config.baseURL.replace(/\/$/, "")}/${operation === "models" ? "models" : "chat/completions"}`;
    }
    LitMTransPort.providerEndpoint = providerEndpoint;
    function providerHeaders(config) {
        return config.protocol === "gemini-interactions" ? { "x-goog-api-key": config.apiKey, "Content-Type": "application/json" } : { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" };
    }
    LitMTransPort.providerHeaders = providerHeaders;
    async function listProviderModels(http, config, signal = null) {
        LitMTransPort.assertLLMConfig(config);
        const result = await http.requestJSON("GET", providerEndpoint(config, "models"), { headers: providerHeaders(config), signal });
        const source = Array.isArray(result) ? result : Array.isArray(result.data) ? result.data : Array.isArray(result.models) ? result.models : [];
        return LitMTransPort.filterTextModels(source, config.provider);
    }
    LitMTransPort.listProviderModels = listProviderModels;
    function requestConstruction(config, messages, options = {}) {
        LitMTransPort.assertLLMConfig(config);
        const payload = config.protocol === "gemini-interactions" ? LitMTransPort.buildGeminiInteractionRequest(config, messages, options) : LitMTransPort.buildOpenAIChatPayload(config, messages, options);
        return { url: config.protocol === "gemini-interactions" ? LitMTransPort.geminiInteractionsURL(config.baseURL, options.stream !== false) : providerEndpoint(config, "complete"), headers: providerHeaders(config), payload };
    }
    LitMTransPort.requestConstruction = requestConstruction;
    function getProviderSpec(id) { return LitMTransPort.providerSpec(id); }
    LitMTransPort.getProviderSpec = getProviderSpec;
    function getTranslationProviderSpec(id) { return LitMTransPort.providerSpec(id); }
    LitMTransPort.getTranslationProviderSpec = getTranslationProviderSpec;
    function translationProviderName(id) { return LitMTransPort.providerSpec(id).name; }
    LitMTransPort.translationProviderName = translationProviderName;
    function providerDefaultBaseUrl(id) { return LitMTransPort.providerSpec(id).defaultBaseURL; }
    LitMTransPort.providerDefaultBaseUrl = providerDefaultBaseUrl;
    function providerPreferredModels(id) { return [LitMTransPort.providerSpec(id).defaultModel].filter(Boolean); }
    LitMTransPort.providerPreferredModels = providerPreferredModels;
    function providerDefaultModel(id) { return LitMTransPort.providerSpec(id).defaultModel; }
    LitMTransPort.providerDefaultModel = providerDefaultModel;
    function providerModelListUrl(id, baseURL) { const config = LitMTransPort.normalizeLLMConfig({ provider: id, baseURL, apiKey: "x", model: LitMTransPort.providerSpec(id).defaultModel }); return providerEndpoint(config, "models"); }
    LitMTransPort.providerModelListUrl = providerModelListUrl;
    function nonMultimodalModelKey(provider, model) { return `${LitMTransPort.normalizeProviderID(provider)}|${String(model || "").trim()}`; }
    LitMTransPort.nonMultimodalModelKey = nonMultimodalModelKey;
    function thinkingCapabilityKey(provider, baseURL, model) { return `${LitMTransPort.normalizeProviderID(provider)}|${LitMTransPort.normalize_ai_base_url(baseURL, provider)}|${String(model || "")}`; }
    LitMTransPort.thinkingCapabilityKey = thinkingCapabilityKey;
    function loadNonMultimodalModelMarks(value) { try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed.map(String) : [];
    }
    catch {
        return [];
    } }
    LitMTransPort.loadNonMultimodalModelMarks = loadNonMultimodalModelMarks;
    function saveNonMultimodalModelMarks(values) { return JSON.stringify([...new Set(values)]); }
    LitMTransPort.saveNonMultimodalModelMarks = saveNonMultimodalModelMarks;
    function cleanupNonMultimodalModelMarks(values, active) { const keep = new Set(active); return values.filter(value => keep.has(value)); }
    LitMTransPort.cleanupNonMultimodalModelMarks = cleanupNonMultimodalModelMarks;
    function loadThinkingCapabilities(value) { try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    }
    catch {
        return {};
    } }
    LitMTransPort.loadThinkingCapabilities = loadThinkingCapabilities;
    function saveThinkingCapabilities(value) { return JSON.stringify(value); }
    LitMTransPort.saveThinkingCapabilities = saveThinkingCapabilities;
    function cachedThinkingCapability(value, key) { return Object.prototype.hasOwnProperty.call(value, key) ? Boolean(value[key]) : null; }
    LitMTransPort.cachedThinkingCapability = cachedThinkingCapability;
    function markThinkingCapability(value, key, supported) { return { ...value, [key]: Boolean(supported) }; }
    LitMTransPort.markThinkingCapability = markThinkingCapability;
    function cleanupThinkingCapabilities(value, active) { const keep = new Set(active); return Object.fromEntries(Object.entries(value).filter(([key]) => keep.has(key))); }
    LitMTransPort.cleanupThinkingCapabilities = cleanupThinkingCapabilities;
    function isMarkedNonMultimodalModel(values, provider, model) { return values.includes(nonMultimodalModelKey(provider, model)); }
    LitMTransPort.isMarkedNonMultimodalModel = isMarkedNonMultimodalModel;
    function markNonMultimodalModel(values, provider, model) { return [...new Set([...values, nonMultimodalModelKey(provider, model)])]; }
    LitMTransPort.markNonMultimodalModel = markNonMultimodalModel;
    function makeParseOutputDir(documentID) { return `${LitMTransPort.safe_document_stem(documentID, "document")}/references`; }
    LitMTransPort.makeParseOutputDir = makeParseOutputDir;
    function isDirectTextInputFile(path) { return LitMTransPort.is_direct_text_input_file(path); }
    LitMTransPort.isDirectTextInputFile = isDirectTextInputFile;
    function storedOriginalPath(documentID, path) { return `${makeParseOutputDir(documentID)}/original/${LitMTransPort.safe_document_stem(LitMTransPort.normalizeOriginalPathHint(path), "source", 120)}`; }
    LitMTransPort.storedOriginalPath = storedOriginalPath;
    function findStoredOriginal(paths) { return paths.find(path => /\/original\//.test(path.replace(/\\/g, "/"))) || ""; }
    LitMTransPort.findStoredOriginal = findStoredOriginal;
    function debugPrintModelResponse(value) { return LitMTransPort.stableStringify(LitMTransPort.redactRequestAudit(value)); }
    LitMTransPort.debugPrintModelResponse = debugPrintModelResponse;
    function debugPrintModelSummary(value) { const text = debugPrintModelResponse(value); return text.length > 1200 ? `${text.slice(0, 1200)}…` : text; }
    LitMTransPort.debugPrintModelSummary = debugPrintModelSummary;
    function loadProviderSecret(store, provider) { return store.get("llm", LitMTransPort.normalizeProviderID(provider)); }
    LitMTransPort.loadProviderSecret = loadProviderSecret;
    function loadProviderBaseUrl(store, provider) { return LitMTransPort.normalize_ai_base_url(store.get(`${LitMTransPort.normalizeProviderID(provider)}BaseURL`, LitMTransPort.providerSpec(provider).defaultBaseURL), provider); }
    LitMTransPort.loadProviderBaseUrl = loadProviderBaseUrl;
    function loadProviderModelSetting(store, provider) { return String(store.get(`${LitMTransPort.normalizeProviderID(provider)}Model`, LitMTransPort.providerSpec(provider).defaultModel)); }
    LitMTransPort.loadProviderModelSetting = loadProviderModelSetting;
    function accept(value) { return String(value || "").trim(); }
    LitMTransPort.accept = accept;
    function loadProviderKey(store, provider) { return loadProviderSecret(store, provider); }
    LitMTransPort.loadProviderKey = loadProviderKey;
})(LitMTransPort || (LitMTransPort = {}));
var LitMTransPort;
(function (LitMTransPort) {
    function createWorkbenchUIState() {
        return {
            mode: "stream", readerView: "both", cleanReading: false, runningOperations: [], selectedQuotes: [],
            embedded: true, topBarVisible: true, compactStyle: true, activeDialog: null,
            modelOptionsVisible: true, layoutChildrenVisible: false, groupChildrenVisible: false,
            documentToolEnabled: false, requestBodyMode: "chat_completions", reasoningPreferences: {}
        };
    }
    LitMTransPort.createWorkbenchUIState = createWorkbenchUIState;
    function applyModeToWorkbench(state, mode) {
        return { ...state, mode, layoutChildrenVisible: mode === "layout", groupChildrenVisible: mode === "layout" && state.groupChildrenVisible };
    }
    LitMTransPort.applyModeToWorkbench = applyModeToWorkbench;
    function eventFilter(event) {
        const type = String(event?.type || "");
        const key = String(event?.key || "");
        return { accepted: !(type === "keydown" && key === "Escape"), event };
    }
    LitMTransPort.eventFilter = eventFilter;
    function Init() { return createWorkbenchUIState(); }
    LitMTransPort.Init = Init;
    function closeEvent(state) {
        return { ...state, runningOperations: [], cleanReading: false, activeDialog: null };
    }
    LitMTransPort.closeEvent = closeEvent;
    function shutdownForApplicationExit(state) { return closeEvent(state); }
    LitMTransPort.shutdownForApplicationExit = shutdownForApplicationExit;
    function configureEmbeddedMode(state, embedded = true) { return { ...state, embedded }; }
    LitMTransPort.configureEmbeddedMode = configureEmbeddedMode;
    function createEmbeddedTopBar(state, visible = true) { return { ...state, topBarVisible: visible }; }
    LitMTransPort.createEmbeddedTopBar = createEmbeddedTopBar;
    function applyEmbeddedCompactStyle(state, enabled = true) { return { ...state, compactStyle: enabled }; }
    LitMTransPort.applyEmbeddedCompactStyle = applyEmbeddedCompactStyle;
    function openModelSettingsDialog(state) { return { ...state, activeDialog: "model-settings" }; }
    LitMTransPort.openModelSettingsDialog = openModelSettingsDialog;
    function keyPointsDefaultPrompt(language = "简体中文") { return LitMTransPort.buildKeyPointsPromptForDocument(language); }
    LitMTransPort.keyPointsDefaultPrompt = keyPointsDefaultPrompt;
    function keyPointsPrompt(value, language = "简体中文") { return String(value || "").trim() || keyPointsDefaultPrompt(language); }
    LitMTransPort.keyPointsPrompt = keyPointsPrompt;
    function saveKeyPointsPromptSetting(value) { return String(value || "").trim(); }
    LitMTransPort.saveKeyPointsPromptSetting = saveKeyPointsPromptSetting;
    function openKeyPointsPromptDialog(state) { return { ...state, activeDialog: "key-points-prompt" }; }
    LitMTransPort.openKeyPointsPromptDialog = openKeyPointsPromptDialog;
    function initUi() { return createWorkbenchUIState(); }
    LitMTransPort.initUi = initUi;
    function applyLeftControlHeightPolicy(value) { return Math.max(0, Math.min(720, Number(value) || 0)); }
    LitMTransPort.applyLeftControlHeightPolicy = applyLeftControlHeightPolicy;
    function getCurrentProvider(settings) { return settings.chatProvider; }
    LitMTransPort.getCurrentProvider = getCurrentProvider;
    function ensureChatSettingsFields(settings) { return LitMTransPort.normalizeSettings(settings); }
    LitMTransPort.ensureChatSettingsFields = ensureChatSettingsFields;
    function reasoningPreferenceKey(provider, model) { return `${LitMTransPort.normalizeProviderID(provider)}|${String(model || "")}`; }
    LitMTransPort.reasoningPreferenceKey = reasoningPreferenceKey;
    function saveReasoningPreferences(state, provider, model, value) {
        const key = reasoningPreferenceKey(provider, model);
        return { ...state, reasoningPreferences: { ...state.reasoningPreferences, [key]: { ...value } } };
    }
    LitMTransPort.saveReasoningPreferences = saveReasoningPreferences;
    function restoreReasoningPreferences(state, provider, model) {
        return state.reasoningPreferences[reasoningPreferenceKey(provider, model)] || { thinkingMode: "default", reasoningEffort: "default", showReasoning: false };
    }
    LitMTransPort.restoreReasoningPreferences = restoreReasoningPreferences;
    function requestBodyModeForProvider(provider) {
        const protocol = LitMTransPort.providerSpec(provider).protocol;
        return protocol === "gemini-interactions" ? "gemini-interactions" : "chat_completions";
    }
    LitMTransPort.requestBodyModeForProvider = requestBodyModeForProvider;
    function setRequestBodyModeForCurrentProvider(state, value) {
        const mode = value === "gemini-interactions" ? "gemini-interactions" : LitMTransPort.normalizeOneapiRequestBodyMode(value);
        return { ...state, requestBodyMode: mode };
    }
    LitMTransPort.setRequestBodyModeForCurrentProvider = setRequestBodyModeForCurrentProvider;
    function syncFromAppSettings(settings) { return LitMTransPort.normalizeSettings(settings); }
    LitMTransPort.syncFromAppSettings = syncFromAppSettings;
    function openProviderCardsDialog(state) { return { ...state, activeDialog: "provider-cards" }; }
    LitMTransPort.openProviderCardsDialog = openProviderCardsDialog;
    function currentAiKeyAvailable(store, provider) { return store.has("llm", LitMTransPort.normalizeProviderID(provider)); }
    LitMTransPort.currentAiKeyAvailable = currentAiKeyAvailable;
    function currentDocumentToolAdapter() { return LitMTransPort.getDocumentToolAdapter(); }
    LitMTransPort.currentDocumentToolAdapter = currentDocumentToolAdapter;
    function documentToolName() { return "MinerU"; }
    LitMTransPort.documentToolName = documentToolName;
    function documentToolKeyAvailable(store) { return store.has("mineru", "official"); }
    LitMTransPort.documentToolKeyAvailable = documentToolKeyAvailable;
    function refreshDocumentToolControls(state, available) { return { ...state, documentToolEnabled: Boolean(available) }; }
    LitMTransPort.refreshDocumentToolControls = refreshDocumentToolControls;
    function mineruKeyAvailable(store) { return documentToolKeyAvailable(store); }
    LitMTransPort.mineruKeyAvailable = mineruKeyAvailable;
    function promptForMissingStartupKeys(missing) {
        return [...new Set((missing || []).map(String).map(value => value.trim()).filter(Boolean))].map(scope => ({ scope, required: true }));
    }
    LitMTransPort.promptForMissingStartupKeys = promptForMissingStartupKeys;
    function setModelOptionsVisible(state, value) { return { ...state, modelOptionsVisible: Boolean(value) }; }
    LitMTransPort.setModelOptionsVisible = setModelOptionsVisible;
    function setLayoutChildrenVisible(state, value) { return { ...state, layoutChildrenVisible: Boolean(value) }; }
    LitMTransPort.setLayoutChildrenVisible = setLayoutChildrenVisible;
    function setGroupChildrenVisible(state, value) { return { ...state, groupChildrenVisible: Boolean(value) }; }
    LitMTransPort.setGroupChildrenVisible = setGroupChildrenVisible;
    function conversationHistoryPath(documentID) { return `${LitMTransPort.safe_document_stem(documentID, "document")}/chat/sessions.json`; }
    LitMTransPort.conversationHistoryPath = conversationHistoryPath;
    function currentTimestampText(now = new Date()) { return now.toISOString(); }
    LitMTransPort.currentTimestampText = currentTimestampText;
    function makeConversationId(documentID, now = new Date()) { return `session-${now.toISOString().replace(/\D/g, "")}-${LitMTransPort.shortHash(documentID)}`; }
    LitMTransPort.makeConversationId = makeConversationId;
    function saveKeys(store, values) {
        const saved = [];
        for (const [provider, value] of Object.entries(values || {})) {
            const key = String(value || "").trim();
            if (!key)
                continue;
            store.set("llm", LitMTransPort.normalizeProviderID(provider), key);
            saved.push(LitMTransPort.normalizeProviderID(provider));
        }
        return saved;
    }
    LitMTransPort.saveKeys = saveKeys;
    function SafeCombo(items = [], selected = "") {
        const normalized = [...new Set(items.map(String).map(value => value.trim()).filter(Boolean))];
        return { items: normalized, selected: normalized.includes(selected) ? selected : (normalized[0] || ""), popupOpen: false, destroyed: false };
    }
    LitMTransPort.SafeCombo = SafeCombo;
    function ShowPopupSafely(value) { return value.destroyed ? value : { ...value, popupOpen: true }; }
    LitMTransPort.ShowPopupSafely = ShowPopupSafely;
    function OnComboDestroyed(value) { return { ...value, popupOpen: false, destroyed: true }; }
    LitMTransPort.OnComboDestroyed = OnComboDestroyed;
})(LitMTransPort || (LitMTransPort = {}));
var LitMTransPort;
(function (LitMTransPort) {
    function createZoteroChatBridge(value) {
        if (!value || typeof value.open !== "function" || typeof value.focusComposer !== "function" || typeof value.locate !== "function") {
            throw new LitMTransPort.PortError("HOST_ADAPTER", "Zotero文档对话桥缺少 open/focusComposer/locate 方法");
        }
        return Object.freeze({
            open(documentID) {
                const id = String(documentID || "").trim();
                if (!id)
                    throw new LitMTransPort.PortError("HOST_ADAPTER", "打开文档对话时缺少 documentID");
                value.open(id);
            },
            focusComposer() { value.focusComposer(); },
            locate(quote) {
                if (!quote?.id)
                    throw new LitMTransPort.PortError("HOST_ADAPTER", "引用定位缺少 quote.id");
                value.locate({ ...quote });
            }
        });
    }
    LitMTransPort.createZoteroChatBridge = createZoteroChatBridge;
})(LitMTransPort || (LitMTransPort = {}));
var LitMTransPort;
(function (LitMTransPort) {
    function layoutReaderContract(attachmentID) { return { attachmentID, source: "zotero-reader", parsedSourceToggleAllowed: false }; }
    LitMTransPort.layoutReaderContract = layoutReaderContract;
    async function openLayoutSource(adapter, attachmentID, frame) { if (!attachmentID)
        throw new LitMTransPort.PortError("HOST_ADAPTER", "缺少Zotero PDF附件 ID"); return adapter.openPreview(attachmentID, frame); }
    LitMTransPort.openLayoutSource = openLayoutSource;
    async function jumpLayoutReader(adapter, attachmentID, page, annotationKey = "") { await adapter.jumpToPage(attachmentID, Math.max(0, Math.trunc(page) - 1), annotationKey); }
    LitMTransPort.jumpLayoutReader = jumpLayoutReader;
    function sourceKindForMode(mode) { return mode === "layout" ? "zotero-reader" : "parsed-markdown"; }
    LitMTransPort.sourceKindForMode = sourceKindForMode;
})(LitMTransPort || (LitMTransPort = {}));
(function (global) {
    const root = global.LitMTrans = global.LitMTrans || {};
    root.PortedCore = LitMTransPort;
})(typeof globalThis !== "undefined" ? globalThis : this);
