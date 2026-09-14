# LitMTrans-Zotero 代码架构速查全景图 (Compact Repo Map)

> 紧凑型代码全景骨架（包含 .js / .ts / .xhtml / .css）。单次 view_file 即可完整吞入（<350行）。覆盖核心扩展层 (src/) 与独立算法包 (packages/)，支持秒级锁定逻辑与 UI 控件。

## 核心扩展运行层 (src/)

### `src/bootstrap.js` (191 行)
- **Functions**: `litmtransLog`, `install`, `startup`, `onMainWindowLoad`, `onMainWindowUnload`, `shutdown`, `uninstall`

### `src/chat.js` (2470 行)
- **class `ChatService`** (L635): `constructor`
- **Functions**: `taskFor`, `decodeTextDocument`, `normalizeReferenceQuote`, `referenceQuoteIdentity`, `normalizeReferenceQuotes`, `normalizeBoolean`, `nonNegativeNumber`, `normalizeLegacyContentParts`, `combinedReferenceText`, `messageTextForAPI`, `normalizeAttachment`, `attachmentConversationReference`, `attachmentTransportLabel`, `isSafeRelativePath`, `normalizeDocumentAttachment`, `normalizeDocumentOptions`, `markdownImagePlaceholders`, `imagePlaceholderKey`, `normalizeCitedImage`, `normalizeMessage`, `responseInfo`, `number`, `deriveTitle`, `trimContext`, `decodeImageDataURL`, `encodeBytesBase64`, `looksLikePayloadTooLargeError`, `looksLikeImageUnsupportedError`, `textOnlyMessages`, `appendDynamicContextToLatestUser`, `messageContentToText`, `messageContentImageDataURLs`, `findTurnRange`, `persistImageUnsupportedModels`, `isImageUnsupported`, `root`, `documentSessionID`, `indexPath`, `sessionPath`, `attachmentDir`, `documentCacheRoot`, `revisionRoot`, `currentDocumentFingerprint`, `markImageUnsupported`, `prepareDocument`, `presentMessage`, `presentSession`, `ensureDocumentSession`, `listSessions`, `writeIndex`, `loadSession`, `saveSession`, `sessionIndexRow`, `archiveDocumentRevision`, `clearSession`, `cleanupUnreferencedDocuments`, `updateSessionModel`, `removeMessageAttachments`, `editMessage`, `deleteTurn`, `persistIncomingImages`, `persistGeneratedImages`, `attachmentDataURL`, `appendAttachmentParts`, `appendUserQuestionAfterImages`, `appendTextPart`, `compressDocumentImage`, `documentImageDataURL`, `currentDocumentImageDataURL`, `currentDocumentImageLocator`, `documentImageLocator`, `resolveAssistantImageCitations`, `currentDocumentMessageParts`, `diagnoseCurrentDocumentImages`, `hasCurrentDocumentSource`, `attachCurrentDocumentToFirstTurn`, `documentMessageParts`, `historyMessagesForAPI`, `responseSummary`, `buildContext`, `buildImageConversationPrompt`, `imageInputsForTurn`, `generateImageReply`, `generateReply`, `persist`, `schedulePersist`, `resend`, `send`

### `src/controller.js` (3416 行)
- **class `Controller`** (L166): `constructor`
- **Functions**: `localize`, `displayTitle`, `safeChatRelativePath`, `evidenceTextKey`, `fuzzyEvidenceKey`, `evidenceNgrams`, `quoteCoverageScore`, `evidenceQuoteSegments`, `findEvidenceSegmentRanges`, `pdfTextHighlightRects`, `evidenceBlockLocation`, `compiledEvidenceMatches`, `log`, `init`, `shutdown`, `loadDeepSeekWeb`, `showStatus`, `setDeepSeekWebBounds`, `ensureDeepSeekWebVisible`, `ensureDeepSeekDriver`, `openDeepSeekContextMenu`, `registerItemDeletionObserver`, `clearCachesForDeletedItems`, `developerDiagnosticsPaths`, `startDeveloperDiagnostics`, `pollDeveloperDiagnostics`, `runDeveloperDiagnostic`, `runEdgeDocumentProbe`, `runEdgeLocalProbe`, `runGeminiTransportProbe`, `developerDiagnosticSnapshot`, `diagnosticPayloadSummary`, `runMultimodalProbe`, `runDocumentMultimodalProbe`, `runChatRoundtripProbe`, `diagnosticUsage`, `number`, `diagnosticError`, `runProviderCacheProbe`, `addToAllWindows`, `ensureWindowLocalization`, `addToWindow`, `refresh`, `removeFromWindow`, `itemCouldHaveAttachment`, `resolveAttachment`, `attachmentPath`, `selectedAttachment`, `selectReferenceFiles`, `selectChatDocumentFile`, `selectPDFExportPath`, `decodeImageDataURL`, `selectImageExportPath`, `saveImageData`, `copyImageData`, `readClipboardText`, `writeClipboardText`, `openWithDefaultApplication`, `openTokenGuide`, `openExternalURL`, `printWorkbenchPDF`, `createGeneratedPDFAttachment`, `createLayoutComparisonPDF`, `normalizePDFBytes`, `draw`, `createLayoutPDFAttachments`, `openFromCurrentSelection`, `alert`, `confirmEdgeModelDownload`, `finish`, `openWorkbenchSafely`, `registerReaderIntegrations`, `register`, `readerItemID`, `registerItemPaneSection`, `tabIDForAttachment`, `openWorkbench`, `cleanupTab`, `installBridge`, `hostCall`, `sendToPage`, `emit`, `handleBridgeCall`, `operationMap`, `activeOperationMap`, `assertOperationAvailable`, `beginOperation`, `finishOperation`, `stopOperations`, `withOperation`, `attachmentContext`, `pdfPageCount`, `stateForAttachment`, `dispatch`, `onLoad`, `createInteractiveReader`, `zoomOriginalPDF`, `emitLocation`, `readerScroll`, `emitSelection`, `drawHighlight`, `getSettings`, `getProviderAPIKey`, `saveProviderAPIKey`, `saveMinerUToken`, `providerCards`, `writeProviderCards`, `getProviderCardAPIKey`, `saveProviderCard`, `applyProviderCard`, `deleteProviderCard`, `saveSettings`, `listModels`, `probeSiliconflowThinking`, `openPreferences`

### `src/deepseek-web/content-script.js` (921 行)
- **Functions**: `delay`, `setTimeoutShim`, `clearTimeoutShim`, `findElement`, `fillControlledInput`, `simulatePaste`, `triggerEnter`, `triggerClick`, `findSendButton`, `isExcluded`, `domToMarkdown`, `walk`, `walkChildren`, `ensureSidebarOpen`

### `src/deepseek-web/driver.js` (461 行)
- **class `DeepSeekWebDriver`** (L128): `constructor`
- **Functions**: `uint8ArrayToBase64`, `extractDelta`, `getActor`, `testActor`, `execute`, `ensureReady`, `isLoggedIn`, `createNewChat`, `navigate`, `stop`, `isGenerating`, `attachFiles`, `attachImages`, `listSessions`, `selectSession`, `renameCurrentSession`, `deleteCurrentSession`, `submitMessage`

### `src/deepseek-web/pdf-pages.js` (250 行)
- **class `PDFPageRenderer`** (L119): `constructor`
- **Functions**: `base64ToUint8Array`, `getPartitionStrategy`, `createCanvas`, `renderSinglePageToCanvas`, `stitchCanvasesHorizontal`, `getPagesDir`, `resolvePDFDocument`, `renderAndCachePages`

### `src/deepseek-web/provider.js` (462 行)
- **class `DeepSeekWebProvider`** (L62): `constructor`
- **Functions**: `uint8ArrayToBase64`, `sanitizePrefix`, `extractUserPrompt`, `formatFullPrompt`, `finalizeTranslationSession`, `getDriver`, `resolveRuntime`, `complete`, `completeTranslationTask`, `abortListener`, `completeDocumentTask`

### `src/deepseek-web/stream.js` (283 行)
- **class `DeepSeekSSEParser`** (L7): `constructor`
- **class `DeepSeekReplyAccumulator`** (L67): `constructor`
- **Functions**: `push`, `_line`, `_flush`, `_isThinking`, `_urlIndex`, `_resolveCitations`, `_append`, `_fragments`, `_batch`, `apply`, `result`, `createStreamDispatcher`

### `src/diagram-viewer.js` (155 行)
- **Functions**: `$`, `stage`, `world`, `applyZoom`, `setZoom`, `askAboutNode`, `fit`, `centerOnElements`, `open`, `close`, `exportDiagram`, `bindPan`, `finish`, `bindWindowDrag`, `init`

### `src/edge-local-translation.js` (843 行)
- **class `EdgeLocalTranslationError extends Error`** (L21): `constructor`
- **class `DevToolsConnection`** (L206): `constructor`
- **class `EdgeLocalTranslator`** (L323): `constructor`
- **Functions**: `abort`, `sleep`, `languageCode`, `baseLanguage`, `normalizeOCRSource`, `replaceOCRReplacementCharacters`, `splitEmptyTranslationRetryText`, `shortenProtectedPlaceholders`, `restoreShortPlaceholders`, `isPlaceholderSensitiveEdgeError`, `splitEdgeLocalRetryText`, `platformIsWindows`, `browserWindow`, `subprocessModule`, `pathExists`, `containsLargeFile`, `onMessage`, `rejectAll`, `command`, `onAbort`, `evaluate`, `close`, `resolveEdgeExecutable`, `allocateDebugPort`, `hostPage`, `fetchFunction`, `systemCommand`, `output`, `edgePIDForDebugPort`, `pidIsRunning`, `start`, `hasCachedLanguageModel`, `downloadModel`, `ensureAvailable`, `ensureSession`, `translateOnce`, `cleanTranslationResult`, `normalizeInputSoftBreaks`, `translateSource`, `translate`, `translateBySegmentsAfterError`, `translateByProtectedSegmentsAfterError`

### `src/flowchart.js` (372 行)
- **Functions**: `cleanLabel`, `comparableID`, `mermaidNodeID`, `parseFlowchart`, `resolveID`, `mermaidSource`, `quote`, `svgDataURL`, `withLightCanvas`, `decorateFlowchartSVG`, `cachedImage`, `ensureMermaid`, `available`, `createImage`, `flowNodeElement`, `flowNodeElements`, `positionDetail`, `evidenceText`, `showNodeEvidence`, `renderInteractive`, `openDetail`, `renderFlowchart`

### `src/http.js` (786 行)
- **class `HTTPError extends Error`** (L8): `constructor`
- **class `RequestTimeoutError extends Error`** (L27): `constructor`
- **class `StreamTimeoutError extends RequestTimeoutError`** (L35): `constructor`
- **Functions**: `retryAfterMilliseconds`, `linkedController`, `abortFromParent`, `readStreamChunk`, `responseTextSafe`, `request`, `requestJSON`, `requestBytes`, `uploadBytes`, `retry`, `extractOpenAIText`, `stringifyReasoning`, `firstReasoningValue`, `extractStreamParts`, `trailingTagPrefixLength`, `streamOpenAI`, `appendVisible`, `appendReasoning`, `processTaggedText`, `processEvent`, `drainEvents`, `geminiUsageToOpenAI`, `parseGeminiInteractionEvent`, `streamGeminiInteractions`, `processFrame`, `drain`

### `src/layout.js` (3787 行)
- **class `LayoutTranslationService`** (L1986): `constructor`
- **Functions**: `singleColumnBodyPromotionEnabled`, `layoutConcurrencyLimit`, `isOfficialDeepSeekConfig`, `stripMarkdownImages`, `completeJSONObjectCandidates`, `normalizedMarkdownSearchText`, `markdownRecordPositions`, `recordFinishesSentence`, `fastLayoutKind`, `hasUnsafeControlCharacters`, `sanitizeModelText`, `validBBox`, `spanText`, `lineText`, `blockText`, `layoutLogicalLines`, `layoutVisualLineCount`, `parseTocLogicalLines`, `parseTocRows`, `parseTocTextRows`, `codeTextFromBlock`, `visit`, `delimitedLayoutTeX`, `layoutSpansToTranslationText`, `isSymbolGlossaryBlock`, `symbolGlossaryMarkers`, `plainBlockText`, `restoreSymbolGlossaryRowBreaks`, `symbolGlossaryParagraphs`, `normalizeCompareText`, `visibleTextLength`, `cjkCount`, `latinCount`, `targetExpectsCJK`, `affiliationLikeText`, `authorBylineLikeText`, `bibliographyLikeText`, `shouldCheckTranslation`, `looksOverexpanded`, `looksUntranslated`, `retryDetailsForRecord`, `isFormatOnlyRetryReasons`, `classifyRetryRecords`, `add`, `recordsNeedingRetry`, `retryReasonSummary`, `untranslatedOrMissingRecords`, `unsafeOverexpandedRecords`, `suspiciousDuplicateTranslationRecords`, `sourceEquationNumbers`, `repairEquationReferenceTranslation`, `normalizeWebMachineRecord`, `formulaSpans`, `looksLikeDisplayFormula`, `imagePathFromBlock`, `inferFontSize`, `normalizePageSize`, `safeLayoutTextToHTML`, `layoutSpansToHTML`, `layoutLinesToHTML`, `normalizeLayoutHTMLSnippet`, `bboxWidth`, `bboxHeight`, `bboxCenter`, `bboxUnion`, `bboxArea`, `bboxContainedOverlapRatio`, `medianValue`, `streamSideForBBox`, `estimateLayoutFontSize`, `fixedLayoutFontSize`, `modelBBoxToPageBBox`, `collectModelOCRBoxes`, `ocrBoxesInRegion`, `estimateFirstLineIndent`, `refinedTextBBoxFromOCR`, `collectMediaCarrierBoxes`, `isLayoutMetadataText`, `looksLikeBodyProseEvidence`, `isBodyTextCandidate`, `looksLikeContinuation`, `assignLayoutColumnKeys`, `bodyColumnProfiles`, `matchesBodyColumnProfile`, `bboxMatchesColumn`, `isEarlyFrontMatterItem`, `promoteTextItemsToBody`, `bodyCandidate`, `seedEligible`, `inferSingleColumnProfile`, `singleColumnProfileMatches`, `promoteStableSingleColumnItems`, `pageHasParallelReadingLanes`, `pageHasSingleColumnAnchor`, `inheritStableSingleColumnShortItems`, `layoutBarrierBoxes`, `horizontalOverlapRatio`, `bodyMergeBlockedByBarrier`, `bodyMergeCreatesBarrierIntrusion`, `singleLineBodyItemsAreAdjacent`, `mergedPartIndent`, `mergedBodyParagraphs`, `mergeVerticalBodyItems`, `emitMerged`, `markEquationDenseBodyItems`, `mergeReferenceItems`, `lineDebugData`, `prepareFlowItems`, `columnRightEdgesFromStreams`, `equationNumberRightForBBox`, `score`, `numberedFormula`, `localColumnRight`, `near`, `notSelf`, `expandNarrowStream`, `retreatIntrudingColumnBoundaries`, `streamParagraphs`, `translatedFlowPlainText`, `streamInnerBBox`, `estimateStreamUsedHeight`, `streamLineMetrics`, `streamBottomGap`, `solveUniformStreamStyle`, `absoluteVisuals`, `pushBlock`, `modelItemTextHTML`, `modelFallbackVisuals`, `expandSpecialAbsoluteBlocks`, `prepareRestoredPage`, `paths`, `loadLayout`, `sourceFingerprint`, `loadRevision`, `ensureRevision`, `flattenPage`, `resolveAsset`, `buildModel`, `extractRecords`, `extractFormulaContext`, `groupRecords`, `fastGroupRecords`, `canUseSoftOverflow`, `flush`, `waitForFastCacheSettle`, `loadTranslations`, `importManualTranslation`, `normalizeManualTranslations`, `mergeManualTranslationResponse`, `buildGuide`, `parseTranslationResponse`, `parseManualTranslationResponse`, `sanitizeManualText`, `translateGroup`, `buildPrimaryUser`, `translateWebMachine`, `translate`, `commitResult`, `recordFastTelemetry`, `translateAndCommit`, `runWorker`, `formatOnly`, `commitRetryResult`, `runRetryWorker`

### `src/llm.js` (1416 行)
- **class `AsyncConcurrencyLimiter`** (L608): `constructor`
- **class `LLMService`** (L676): `constructor`
- **Functions**: `requestTimeout`, `positiveFontSize`, `normalizeThinkingMode`, `isDeepSeekReasoningProtocol`, `isGeminiProvider`, `isDeepSeekProvider`, `isOfficialDeepSeekProvider`, `providerConcurrencyLimit`, `geminiOpenAIChatURL`, `normalizeGeminiModelID`, `geminiSupportsThinkingNone`, `normalizeGeminiReasoningEffort`, `geminiPublicThinkingConfig`, `isProbablyReasoningModel`, `isProbablyImageModel`, `modelNameTokens`, `chooseChatModel`, `chooseTranslationModel`, `safeChatProvider`, `applyPromptCacheSession`, `openRouterCacheMode`, `addOpenRouterCacheBreakpoint`, `applyOpenRouterCacheStrategy`, `zeroPrice`, `formatOpenRouterPricePerMillion`, `translationModelOptions`, `quality`, `decodeBase64Bytes`, `decodeImageDataURL`, `detectImageMimeType`, `collectImageResponse`, `visit`, `normalizeReasoningEffort`, `shouldSendTemperature`, `siliconflowCapabilityKey`, `siliconflowSupportsThinking`, `siliconflowThinkingCapability`, `isSiliconflowProvider`, `markSiliconflowThinkingCapability`, `applyReasoningPayload`, `readStringArrayPref`, `readObjectPref`, `reasoningPreferenceKey`, `readReasoningPreferences`, `sanitizeContentForAPI`, `remove`, `pump`, `release`, `acquire`, `run`, `setWebProvider`, `beginManualTransport`, `takeManualTransportRequest`, `endManualTransport`, `waitForGeminiCooldown`, `registerGeminiCooldown`, `getSettings`, `getStoredSettings`, `saveSettings`, `isWebEngineActive`, `resolveConfig`, `requestHeaders`, `listModels`, `probeSiliconflowThinking`, `ensureConfiguredModel`, `completeGeminiNative`, `completeOnce`, `request`, `complete`, `generateImage`, `postMultipart`

### `src/markdown.js` (1196 行)
- **Functions**: `markdownBlocks`, `flush`, `injectSyncAnchors`, `mathRanges`, `splitOversizedBlock`, `splitForTranslation`, `extractMathTokens`, `formulaTokenBody`, `collapseRedundantFormulaBraces`, `normalizeMathBodyForRetry`, `formulaRetryDetail`, `mathIntegrityIssue`, `mathRetryIssue`, `isOCRNonMathFormulaToken`, `mathMissingFormulaRetryIssue`, `normalizeTranslatedInlineHTML`, `sourceEquationReferenceNumbers`, `repairEquationReferenceTranslation`, `repairTranslatedImagePlaceholders`, `readTeXAtom`, `renderTeXMatrix`, `renderTeXBody`, `renderTeXUncached`, `renderTeX`, `splitTableRow`, `repairPipeTableBlock`, `tableRow`, `repairMalformedPipeTables`, `repairFragmentedInlineMath`, `repairPaddedDollarMath`, `normalizeBareTeXFragments`, `protect`, `normalizeEscapedTeXDelimiters`, `isTableSeparator`, `protectInline`, `safeAllowedHTML`, `renderInline`, `startsRawHTMLTable`, `renderRawHTMLTable`, `safeURL`, `renderChildren`, `renderNode`, `cellAttributes`, `renderRow`, `renderSection`, `toXHTMLFragment`, `applyReaderPolish`, `normalize`, `captionLead`, `captionContinuation`, `renderMarkdown`, `extractHeadings`

### `src/mindmap-v2.js` (265 行)
- **Functions**: `clean`, `safeJSON`, `parse`, `visit`, `metrics`, `layout`, `branchWeight`, `make`, `descend`, `placeSide`, `getLeaves`, `y`, `x`, `render`, `isVisible`, `svgForMap`, `escape`, `chunk`, `imageForMap`

### `src/mindmap.js` (171 行)
- **Functions**: `node`, `parseMarkdownMindmap`, `escapeHTML`, `mathHTML`, `labelMetrics`, `color`, `svgDataURL`, `createMindmapImage`, `makeEntry`, `descend`, `leafCount`, `sideLeaves`, `layoutSide`, `place`, `placeX`, `create`, `renderMindmap`

### `src/mineru.js` (1029 行)
- **class `MinerUService`** (L261): `constructor`
- **Functions**: `mineruBoundaryScore`, `chooseMinerUSplitEnd`, `planMinerUPageRanges`, `rebaseMinerUPayload`, `mergedMinerUJSON`, `normalizeAssetKey`, `basename`, `localMarkdownImageTargets`, `zipU16`, `zipU32`, `zipU64`, `zipCRC32`, `readPortableZip`, `readPortableZipEntry`, `dataURIExtension`, `extensionFromTarget`, `decodeBase64`, `queryQuota`, `buildDataID`, `shortUploadName`, `submit`, `upload`, `poll`, `downloadResult`, `extractZip`, `copyAssetFiles`, `simplifyMarkdownImages`, `resolveAsset`, `processTarget`, `locateResultFiles`, `byName`, `parseExternalReference`, `prepareUploadParts`, `runUploadPart`, `forward`, `mergeUploadPartResults`, `parse`, `loadParsed`

### `src/pipeline.js` (471 行)
- **class `DocumentPipeline`** (L13): `constructor`
- **Functions**: `buildLayoutState`, `attachImageWidths`, `normalize`, `imageIdentity`, `remember`, `snapshot`, `parse`, `translateStream`, `translateLayout`, `manualTranslationCommand`, `importManualTranslation`, `mergeManualTranslationResponse`, `manualTranslationRecoveryCommand`, `logTranslationEvent`, `runTranslationWithPersistentLog`, `flushReasoningLogs`, `clearTranslation`, `clearDocument`

### `src/preferences.css`
- **样式表 (175 行)**: 核心样式类: `litmtrans-pref-shell, litmtrans-pref-header, error, primary, litmtrans-token-guide-link, litmtrans-pref-board, litmtrans-pref-column, litmtrans-pref-card, litmtrans-pref-card-chat, litmtrans-pref-card-translation, litmtrans-pref-card-mineru, litmtrans-pref-card-model` ... (共 56 个类)

### `src/preferences.js` (414 行)
- **Functions**: `controller`, `option`, `setSelectOptions`, `setSelectValue`, `bindLanguagePicker`, `isWebMachineTranslationProvider`, `isEdgeLocalTranslationProvider`, `isOfficialDeepSeekTranslation`, `updateProviderLabel`, `updateDeepSeekFastLayoutControl`, `syncChatSettingsFromTranslation`, `updateTranslationContextControls`, `updateWebMachineTranslationSettings`, `init`, `populateProviders`, `load`, `updateChatModelSectionVisibility`, `updateCustomTranslationInstruction`, `payload`, `save`, `refreshModels`, `renderReferencePaths`, `providerChanged`, `bind`, `initializeLitMTransPreferences`

### `src/preferences.xhtml`
- **UI 布局模板 (133 行)**: 涵盖 50 个控件/容器元素
  - **首选项表单项**: `litmtrans-pref-open-token-guide`, `litmtrans-pref-message`, `litmtrans-pref-save`, `litmtrans-pref-mineru-token`, `litmtrans-pref-mineru-model`, `litmtrans-pref-chat-engine-web`, `litmtrans-pref-web-mode-notice`, `litmtrans-pref-model-form-container`, `litmtrans-pref-shared-toggle-container`, `litmtrans-pref-chat-uses-translation-model` ... (共 49 个配置项)

### `src/secrets.js` (180 行)
- **class `Secrets`** (L7): `constructor`
- **Functions**: `_findAll`, `_fallbackGet`, `_fallbackSet`, `get`, `has`, `set`, `remove`, `llmKeyName`, `getLLMKey`, `setLLMKey`, `removeLLMKey`, `getMinerUToken`, `setMinerUToken`, `removeMinerUToken`

### `src/storage.js` (472 行)
- **class `Storage`** (L7): `constructor`
- **Functions**: `init`, `migrateLegacyRoot`, `mergeMissingTree`, `shutdown`, `exists`, `ensureDir`, `readText`, `writeText`, `appendText`, `readJSON`, `writeJSON`, `readBytes`, `writeBytes`, `copyFile`, `copyTree`, `publishFilesAtomically`, `publishEntriesAtomically`, `remove`, `stat`, `list`, `walk`, `visit`, `documentID`, `documentDir`, `path`, `temporaryDir`, `resourceURL`, `sourceIdentity`, `ensureDocument`, `getDocumentMeta`, `setDocumentMeta`, `clearDocument`, `clearDocumentsForDeletedItemIDs`, `clearTranslation`, `processLogPath`, `appendProcessLog`, `readProcessLog`, `writeRequestAudit`

### `src/translation.js` (1266 行)
- **class `TranslationService`** (L150): `constructor`
- **Functions**: `streamChunkConcurrency`, `compactReferenceMarkdown`, `referenceContextInstruction`, `languageSlug`, `completionInstruction`, `stableTranslationMarker`, `translationMarkerDetected`, `stripTranslationMarker`, `cleanTranslationTailArtifacts`, `continuationPrompt`, `translationIdentity`, `paths`, `publishFinal`, `manualCompletionMarker`, `importManualTranslation`, `buildReferenceCorpus`, `load`, `audit`, `buildGuide`, `baseSystemPrompt`, `translate`, `clearWorkingState`, `translateWebMachine`, `translateChunked`, `commitResult`, `translateOneChunk`, `worker`, `translateFullContext`, `makeSystem`, `makeUser`, `schedulePersist`

### `src/utils.js` (853 行)
- **class `CancelledError extends Error`** (L227): `constructor`
- **Functions**: `normalizeLanguageName`, `base64Function`, `base64Encode`, `base64Decode`, `encodeBytesBase64`, `detectImageMimeType`, `decodeImageDataURL`, `newAbortController`, `throwIfAborted`, `sleep`, `onAbort`, `randomID`, `hashString`, `sha256Fallback`, `rotr`, `sha256Hex`, `sha256Bytes`, `opaqueCacheKey`, `randomCacheKey`, `safeStem`, `extension`, `chatImageExtension`, `localTimestampToken`, `pad`, `pastedImageName`, `isIdentifiedPastedImageName`, `escapeHTML`, `escapeAttribute`, `normalizeError`, `isMinerUTokenCredentialError`, `clonePlain`, `getPref`, `setPref`, `clearPref`, `migrateLegacyPreferences`, `normalizeProviderID`, `providerSpec`, `isWebMachineProvider`, `isOpenAICompatibleGateway`, `modelNameTokens`, `chooseChatModel`, `isProbablyImageModel`, `chooseTranslationModel`, `normalizeBaseURL`, `endpointURL`, `createLocalFile`, `fileURI`, `resourceURL`, `stripCodeFence`, `extractJSONObject`, `repairInvalidJSONEscapes`, `cleanText`, `collapseWhitespace`, `markerDetected`, `stripMarker`, `targetLanguageInstruction`, `redactLocalPaths`, `throttled`, `imageAnchorKey`, `sharedImageAnchorKeys`, `counts`

### `src/web-machine-translation.js` (705 行)
- **class `WebMachineTranslationError extends Error`** (L22): `constructor`
- **class `WebMachineTranslator`** (L101): `constructor`
- **class `FallbackMachineTranslator`** (L205): `constructor`, `cloneForWorker`, `probeGoogleIfNeeded`, `switchToBing`, `translate`
- **class `AsyncMutex`** (L214): `constructor`, `acquire`
- **class `WebMachineTranslationService`** (L468): `constructor`
- **Functions**: `escapeRE`, `sha1`, `htmlDecode`, `removeControls`, `isCancellationError`, `rethrowCancellation`, `abort`, `sleep`, `languageCode`, `splitText`, `shouldTranslateText`, `cookieHeader`, `captureCookies`, `openText`, `translate`, `translateGoogle`, `bingSID`, `translateBingOnce`, `translateBing`, `translateBingAdaptive`, `release`, `protectedRanges`, `splitInlineTokens`, `pythonCompatiblePlaceholderValue`, `inlinePlaceholder`, `tolerantPattern`, `protectInlineTokens`, `restoreInlineTokens`, `batchMarker`, `encodeTranslationBatch`, `parseTranslationBatch`, `restoreCitationMarkup`, `chineseTarget`, `headingTranslation`, `probableAuthorLine`, `qualityIssues`, `normalizeAcademic`, `markdownBlocks`, `markdownItem`, `withEdgeTranslator`, `stop`, `shutdown`, `translateItems`, `translateMarkdown`, `update`, `translateRecords`, `publishProgress`, `translatorLabel`, `isWebMachineProvider`, `providerLabel`, `protectInline`, `restoreInline`, `encodeBatch`, `parseBatch`

### `src/workbench.css`
- **样式表 (947 行)**: 核心样式类: `ttf, app-shell, topbar, identity, identity-icon, identity-copy, identity-line, document-subtitle, status-chip, status-running, status-success, status-error` ... (共 410 个类)

### `src/workbench.js` (9025 行)
- **Functions**: `$`, `cacheElements`, `requestID`, `hostFunction`, `hostCall`, `syncWorkbenchViewport`, `imageResolver`, `renderMarkdown`, `renderMarkdownInto`, `safeSetElementHTML`, `normalizeUserMessage`, `toast`, `recordSystemMessage`, `updateReasoningText`, `appendLogRow`, `appendTaskMessageRow`, `renderTaskMessages`, `addLog`, `reasoningLogLabel`, `appendReasoningLog`, `showOperationLog`, `hideOperationLogAfterCompletion`, `shouldAutoOpenOperationLog`, `setStatus`, `restoreIdleStatus`, `updateOperationUI`, `reconcileOperationState`, `handleEvent`, `setData`, `ensureSourcePDF`, `renderAll`, `updateCapabilities`, `renderStreamPanes`, `liveTranslationPreviewNode`, `replaceLiveTranslationPreview`, `appendLiveTranslationPreview`, `translationIsNearBottom`, `keepTranslationAtLatest`, `flushTranslationRender`, `scheduleTranslationRender`, `hasLayoutLivePreview`, `renderLayoutLivePreview`, `flushLayoutLivePreview`, `scheduleLayoutLivePreview`, `splitTeXEquationTag`, `formulaTeXWithoutTag`, `renderLayoutTranslatedText`, `renderLayoutTocRows`, `layoutBlockHTML`, `placeLayoutNode`, `layoutPartHTML`, `appendLayoutDebugLines`, `buildFlowStreamNode`, `buildAbsoluteLayoutNode`, `layoutTextRects`, `layoutRectsOverlap`, `layoutRectUnion`, `layoutNodeCollision`, `layoutNodeFits`, `applyLayoutNodeStyle`, `allNodesFit`, `medianValueLocal`, `layoutTitleFrameFill`, `expandUnderfilledLayoutTitles`, `clusterLayoutTitleFontSizes`, `applyCluster`, `collectPageColumnRights`, `calibrateEquationNumberRight`, `fitLayoutFormulas`, `fitLayoutPages`, `layoutFitSnapshotKey`, `layoutFitPageKey`, `layoutFitStorageKey`, `applyLayoutBodyFont`, `applyLayoutFitSnapshot`, `restoreInjectedLayoutFitSnapshot`, `restoreLayoutFitSnapshot`, `saveLayoutFitSnapshot`, `runLayoutFit`, `ensureLayoutFit`, `nextLayoutPaint`, `queueLayoutPageScaleRefresh`, `waitForLayoutFitToSettle`, `scheduleLayoutPaneSettle`, `task`, `applyLayoutPageRenderScale`, `layoutTranslationPageState`, `fitLayoutText`, `buildLayoutDocument`, `scheduleFit`, `update`, `cleanupLayoutObservers`, `installLayoutImageMemoryManager`, `cancelUnload`, `restoreAll`, `waitForImages`, `finish`, `layoutImageMemoryManagers`, `prepareLayoutImagesForPrint`, `restoreLayoutImagesForPrintEvent`, `resumeLayoutImageMemoryManagement`, `reflectAutomaticLayoutFont`, `renderLayoutPane`, `renderLayoutPanes`, `layoutPageAtViewportAnchor`, `alignLayoutPagePosition`, `captureLayoutScrollPosition`, `restoreLayoutScrollPosition`, `renderMode`, `renderReaderView`, `changeTranslationLayoutPageZoom`, `renderChatSessions`, `readFileAsDataURL`, `dataURLByteLength`, `loadComposerImage`, `prepareComposerImage`, `isImageFileCandidate`, `inferImageMimeType`, `imageDescriptorDataURL`, `applyPreviewScale`, `fitPreviewImage`, `openImagePreview`, `addImageDescriptorToComposer`, `reusePreviewImage`, `copyPreviewImage`, `savePreviewImage`, `addImageFiles`, `renderPendingImages`, `renderPendingDocuments`, `documentGallery`, `attachmentGallery`, `addAction`, `dismiss`, `legacyImageGallery`, `citedImageGallery`, `imageCitationDisplayText`, `legacyDocumentDisplayText`, `reasoningNode`, `messageNode`, `askDiagramNode`, `saveDiagramImage`, `resolveEvidence`, `locateEvidence`, `renderChat`, `streamNode`, `chatIsNearBottom`, `scrollChatToLatest`, `updateStreamingChatDOM`, `messageNavigatorSummary`, `renderMessageNavigator`, `renderSystemMessages`, `showPersistentTranslationLogs`, `hasCurrentTranslationForExport`, `layoutPDFExportIdentity`, `waitForLayoutPDFReady`, `frozenPrintStyle`, `clearFlowingTextForPrint`, `copyFrozenTextStyle`, `sourcePx`, `printTextSegments`, `appendFrozenTextFragments`, `appendFrozenKaTeXFragments`, `appendFrozenInlineAtoms`, `withFrozenLayoutPrintRoot`, `layoutPaintPrintStyle`, `copyLayoutCanvasPaint`, `withLayoutPaintPrintRoot`, `exportCurrentTranslationPDF`, `createLayoutPDFAttachmentsAfterTranslation`, `queueLayoutPDFAttachmentsAfterFinalPublication`, `chatContextPayload`, `hasParsedCurrentDocument`, `confirmParseBeforeChatSend`, `onClose`, `ensureParsedBeforeChatSend`, `resendChatMessage`, `editChatMessage`, `deleteChatTurn`, `normalizeReferenceQuote`, `referenceQuoteIdentity`, `appendReferenceQuote`, `layoutFormulaTarget`, `layoutFormulaTeX`, `layoutFormulaQuote`, `askLayoutFormula`, `applyFormulaPreviewTransform`, `fitFormulaPreview`, `openLayoutFormulaViewer`, `readerPaneForTarget`, `readerSelectionQuote`, `readerImageQuote`, `scrollRatio`, `captureModeScrollPosition`, `restoreModeScrollPosition`, `restore`, `cleanReadingSnapshot`, `updateCleanReaderButton`, `enterCleanReader`, `exitCleanReader`, `setAIMode`, `syncDeepSeekWebBounds`, `sendToDeepSeekWeb`, `prepareReaderAsk`, `renderNativePDFSelectionToolbar`, `askNativePDFSelection`, `exportReaderTranslationPDF`, `bindLayoutInteractions`, `removeMenu`, `addSeparator`, `removeReferenceQuote`, `referenceQuoteNode`, `normalizedVisibleText`, `exactTextRange`, `showReferenceFocus`, `imageLocatorKey`, `switchToReferenceMode`, `revealReferenceQuote`, `renderSelection`, `setSelectOptions`, `setSelectValue`, `bindLanguagePicker`, `isWebMachineTranslationProvider`, `isEdgeLocalTranslationProvider`, `isOfficialDeepSeekTranslation`, `updateProviderLabel`, `updateDeepSeekFastLayoutControl`, `syncChatSettingsFromTranslation`, `updateTranslationContextControls`, `populateSettings`, `updateWebMachineTranslationSettings`, `updateChatModelSectionVisibility`, `fitSettingsDialog`, `updateChatImageSettingsVisibility`, `restoreChatReasoningPreference`, `updateEmbeddedChatImageSettingsVisibility`, `populateEmbeddedChatSettings`, `refreshInlineChatModels`, `embeddedChatSettingsPayload`, `renderReferencePaths`, `renderCustomTranslationInstructionPreview`, `providerCardByID`, `setProviderCardAPIKeyState`, `loadProviderCardEditor`, `newProviderCard`, `renderProviderCards`, `saveProviderCard`, `settingsPayload`, `initialize`, `refreshState`, `translationConfigurationField`, `openSettingsDialog`, `ensureMinerUTokenForParse`, `onKeyDown`, `onSave`, `runAction`, `refreshChatSessions`, `applyOpenContext`, `copyText`, `bindScrollSync`, `anchorY`, `dedupeAnchors`, `imageAnchor`, `anchorCatalogFor`, `pairedAnchorsFor`, `keepSharedImageOrEdge`, `payloadFor`, `scrollToPayload`, `invalidate`, `queueSync`, `bind`, `markUserIntent`, `bindSplitHandle`, `isStacked`, `move`, `bindSidebarSplitHandle`, `maximumWidth`, `apply`, `syncSplitHandleOrientation`, `detectDiagramIntent`, `bindEditableContextMenu`, `editableControl`, `selectionRange`, `replaceSelection`, `selectedText`, `writeSelectedText`, `bindEvents`, `recommendedTranslationModeForLongPDF`, `startTranslation`, `openManualTranslation`, `manualStepLabel`, `renderManualTranslationSteps`, `toggleLayoutDebugMode`, `submitPaperAITask`, `triggerDeepSeekContextMenu`, `closeMenu`, `stopPreviewDrag`, `stopFormulaDrag`, `saveCredential`, `refreshModels`, `probeSiliconflowModel`, `waitForHost`, `isBodyIterationNode`, `bodyIterationNodes`, `setDiagnosticTitle`, `resetBodyIterationInspection`, `beginBodyIterationProbe`, `recordBodyIterationCollision`, `publishBodyIterationInspection`, `publishCachedBodyIterationInspection`, `scopedNodes`, `fitCacheKey`, `fitCacheNodes`, `restoreFitCache`, `saveFitCache`, `measureTextBand`, `layoutPageCoordinateScale`, `layoutPageSourceSize`, `textRectsInPage`, `viewportRectInPage`, `renderedContentRectsInPage`, `elementBoxInPage`, `singleLineTextExceedsPage`, `demoteFalseSingleLineText`, `rectsOverlap`, `rectUnion`, `horizontalBoxesOverlap`, `blockDebugName`, `textCollisionDetails`, `applyGroup`, `layoutControlFontSize`, `measureGroup`, `measureAt`, `wouldCollideWithBlocks`, `clearFitMarks`, `ensureCollisionDebugLayer`, `clearCollisionDebugLayer`, `clearAllCollisionDebugLayers`, `drawCollisionDebug`, `markLimiter`, `tuneGroup`, `syncInheritedBodyFontToBodyGroup`, `tuneEach`, `titleFrameFill`, `expandUnderfilledTitles`, `clusterTitleFontSizes`, `renderedTextLineCount`, `keepShortTitlesOnOneLine`, `gallopingGrow`, `at`, `tuneNodes`, `continueUnderfilledNodes`, `fillRatio`, `snapshotStyles`, `restoreStyles`, `markUniformFontStop`, `recoverCollisionByLineRatio`, `clampTranslatedOverflow`, `clampTranslatedCodeOverflow`, `enforceFinalTextCollisionSafety`, `refreshLayoutPageScales`, `runLayoutParityEngine`, `tuneCaptionGroup`

### `src/workbench.xhtml`
- **UI 布局模板 (522 行)**: 涵盖 216 个控件/容器元素
  - **弹窗对话框**: `#long-document-translation-dialog`, `#manual-translation-dialog`, `#chat-parse-before-send-dialog`, `#mineru-token-dialog`, `#chat-model-settings-dialog`, `#settings-dialog`, `#custom-translation-instruction-dialog`, `#provider-cards-dialog`, `#system-messages-dialog`, `#image-preview-dialog`, `#formula-preview-dialog`, `#diagram-viewer-dialog`
  - **顶栏操作按钮**: `#translate-button(翻译当前阅读模式)`, `#manual-translate-button(将翻译命令复制给)`, `#stop-button(停止当前操作)`, `#export-pdf-button(导出当前显示的译)`, `#clean-reader-button(隐藏对话侧栏)`, `#system-messages-button(查看任务和系统消)`, `#settings-button(设置)`
  - **阅读工具控件**: `#stream-mode-button`, `#layout-mode-button`, `#both-panes-button`, `#source-only-button`, `#translation-only-button`, `#clean-reader-ai-button`, `#sync-scroll-check`, `#reader-font-input`, `#key-points-button`, `#paper-mindmap-button`

## 独立算法与核心包 (packages/)

### `packages/core/src/chat.ts` (82 行)
- **Functions**: `messageContentTextParts`, `messageContentToFullText`, `messageContentToDisplayText`, `normalizeChatMessage`, `createChatSession`, `archiveDocumentRevision`, `markdownImageReferences`, `buildDocumentContextForMessage`, `buildSearchAgentStylesheet`, `buildDocumentToolAdapter`, `setDocumentToolAdapter`, `getDocumentToolAdapter`, `normalizeAgentConfiguration`, `configureResearchAiBase`, `configureSearchAiBase`, `openAiAgentDialog`, `openDocumentChat`, `installSearchAgentDialogStyleFilter`

### `packages/core/src/clean_reading.ts` (45 行)
- **Functions**: `readingModeContract`, `captureCleanReadingSnapshot`, `ratio`, `exitCleanReadingSnapshot`, `validateReaderModeState`

### `packages/core/src/config.ts` (128 行)
- **Functions**: `normalizeSettings`, `positiveFontSize`, `normalizeOneapiRequestBodyMode`, `editOneapiRequestBodyMode`, `utf8Bytes`, `utf8Text`, `requireSecretProtector`, `protectSecret`, `unprotectSecret`, `BlobFromBytes`, `DpapiProtect`, `DpapiUnprotect`, `SettingsFromDict`, `loadSettings`, `saveSettings`, `secretPath`, `saveSecret`, `loadSecret`, `deleteSecret`, `getBasePath`, `normalizeClasses`, `applyElevation`, `removeElevation`, `buildDarkPremiumStylesheet`, `applyMonochromeAppStyle`, `createSilentMessageBox`, `configureSilentApplication`, `showSilentMessage`, `makeStaticMessage`, `show`, `about`, `applyGoogleSansCodeFont`, `installQtWarningFilter`, `messageHandler`, `ensureValidApplicationFont`, `makeComboPopupOnClick`

### `packages/core/src/document.ts` (18 行)
- **Functions**: `documentID`, `normalizeOriginalPathHint`, `newNormalizedDocument`, `updateDocumentFingerprint`, `sourceChanged`

### `packages/core/src/errors.ts` (64 行)
- **class `PortError extends Error`** (L8)
- **class `CancelledError extends PortError`** (L26): `constructor`
- **Functions**: `normalizePortError`, `serializePortError`

### `packages/core/src/http.ts` (54 行)
- **Functions**: `retryableHttpStatus`, `normalizeUsage`, `parseSSEFrames`, `redactRequestAudit`, `removeLocalAbsolutePaths`

### `packages/core/src/layout_model.ts` (229 行)
- **Functions**: `normalizeBBox`, `normalizeBlockType`, `layoutLogicalLines`, `parseTocRows`, `codeTextFromLayoutBlock`, `normalizeLayoutBlock`, `collectRawPages`, `normalizeLayoutDocument`, `visit`, `stripTexWrappers`, `extractBraced`, `texCommandToText`, `splitTexGroup`, `parseTexishSegments`, `normalizeHtmlTableCellText`, `parseRawHtmlTable`, `splitMarkdownTableCells`, `isMarkdownSeparatorRow`, `markdownTableRow`, `repairPipeTableBlock`, `repairMalformedPipeTables`, `researchCss`

### `packages/core/src/layout_translation.ts` (189 行)
- **Functions**: `inlineTexToSafeText`, `neutralizeBrokenInlineTex`, `normalizeMathComparisonEntities`, `inlineFormulaIntegrityIssue`, `formulaTokenBody`, `collapseRedundantFormulaBraces`, `normalizeMathBodyForRetry`, `inlineFormulaRetryIssue`, `tokens`, `isOCRNonMathToken`, `plainBlockText`, `iterTranslatableBlocks`, `iterFormulaContext`, `repairInvalidJsonEscapes`, `extractJsonObject`, `blockPayload`, `formulaPayload`, `normalizeFormulaTex`, `targetExpectsCjk`, `cjkCount`, `latinCount`, `normalizedCompareText`, `sourceEquationNumbers`, `repairEquationReferenceTranslation`, `affiliationLikeText`, `authorBylineLikeText`, `shouldCheckTranslation`, `visibleTextLength`, `looksOverexpanded`, `looksUntranslated`, `suspiciousDuplicateTranslationRecords`, `recordsNeedingRetry`, `repairRecordTranslation`, `repairRecordTranslations`, `applyFormulaReplacements`, `buildGlobalGuide`, `buildTranslationPrompt`, `splitRecords`

### `packages/core/src/legacy_port.ts` (21 行)
- **Functions**: `migrationIdentityKey`, `validateMigrationIdentity`, `snakeToCamel`

### `packages/core/src/markdown.ts` (102 行)
- **Functions**: `cleanMarkdownText`, `markdownBlocks`, `flush`, `markdown_block_translation_text`, `splitMarkdownByChars`, `normalizeMarkdownImageTargets`, `markerDetected`, `stripCompletionMarker`, `formulaDelimiterBalance`

### `packages/core/src/path_safety.ts` (81 行)
- **Functions**: `safe_document_stem`, `shortHash`, `normalizeRelativePath`, `deduplicateRelativePath`, `shortenWindowsPath`, `commonDirectoryPrefix`

### `packages/core/src/references.ts` (55 行)
- **Functions**: `referenceQuoteIdentity`, `normalizeReferenceQuote`, `appendPendingReferenceQuote`, `combinedPendingReferenceQuote`, `locateReference`

### `packages/core/src/task.ts` (120 行)
- **class `TaskContext`** (L78): `constructor`
- **Functions**: `throwIfAborted`, `cancellableSleep`, `abort`, `retryDelay`, `runWithRetry`, `progress`, `cleanup`, `runTask`

### `packages/core/src/translation.ts` (92 行)
- **Functions**: `generatedOutputMarkerPath`, `targetLanguageInstruction`, `buildKeyPointsPromptForDocument`, `buildTranslationChunks`, `buildStreamTranslationMessages`, `acceptStreamChunk`, `mergeTranslatedChunks`, `createTranslationArtifact`, `shouldPublishTranslation`, `readKeyFileLines`, `loadLabelledSecret`, `loadKeySetting`, `saveKey`, `createReaderWindow`

### `packages/document-model/src/atomic_publish.ts` (57 行)
- **Functions**: `createAtomicPublishPlan`, `atomicPublish`

### `packages/document-model/src/cache.ts` (88 行)
- **Functions**: `stableStringify`, `fingerprintText`, `sourceFingerprint`, `translationIsCurrent`, `assertTranslationCurrent`, `migrateCacheManifest`, `latest_translation_path`, `currentWorkDir`, `output_dir_for_pdf`, `latest_output_dir_for_file`, `markGeneratedOutputDir`, `isGeneratedOutputDir`, `createArchiveEntry`

### `packages/document-model/src/input.ts` (33 行)
- **Functions**: `inputExtension`, `is_supported_input_file`, `is_direct_text_input_file`, `inputKind`

### `packages/llm/src/client.ts` (52 行)
- **Functions**: `providerEndpoint`, `providerHeaders`, `listProviderModels`, `requestConstruction`, `getProviderSpec`, `getTranslationProviderSpec`, `translationProviderName`, `providerDefaultBaseUrl`, `providerPreferredModels`, `providerDefaultModel`, `providerModelListUrl`, `nonMultimodalModelKey`, `thinkingCapabilityKey`, `loadNonMultimodalModelMarks`, `saveNonMultimodalModelMarks`, `cleanupNonMultimodalModelMarks`, `loadThinkingCapabilities`, `saveThinkingCapabilities`, `cachedThinkingCapability`, `markThinkingCapability`, `cleanupThinkingCapabilities`, `isMarkedNonMultimodalModel`, `markNonMultimodalModel`, `makeParseOutputDir`, `isDirectTextInputFile`, `storedOriginalPath`, `findStoredOriginal`, `debugPrintModelResponse`, `debugPrintModelSummary`, `loadProviderSecret`, `loadProviderBaseUrl`, `loadProviderModelSetting`, `accept`, `loadProviderKey`

### `packages/llm/src/config.ts` (16 行)
- **Functions**: `normalizeLLMConfig`, `assertLLMConfig`

### `packages/llm/src/gemini.ts` (157 行)
- **Functions**: `geminiContentParts`, `geminiInteractionInput`, `buildGeminiInteractionRequest`, `geminiDeltaText`, `parseGeminiInteractionEvent`, `extractGeminiInteractionText`, `visit`, `extractGeminiThoughtSummary`, `geminiInteractionsURL`, `geminiModelsURL`

### `packages/llm/src/images.ts` (12 行)
- **Functions**: `detectImageMimeType`, `isProbablyImageModel`

### `packages/llm/src/models.ts` (28 行)
- **Functions**: `normalizeModelRecord`, `list`, `isTextGenerationModel`, `filterTextModels`, `chooseTranslationModel`, `chooseChatModel`

### `packages/llm/src/normalization.ts` (15 行)
- **Functions**: `normalizeCompletionResult`, `mergeUsage`, `normalizeProviderError`

### `packages/llm/src/providers.ts` (63 行)
- **Functions**: `normalizeProviderID`, `providerSpec`, `normalize_ai_base_url`, `normalize_gemini_model_id`, `is_gemini_provider`, `gemini_translation_thinking_config`, `parseProviders`

### `packages/llm/src/request_construction.ts` (26 行)
- **Functions**: `sanitizeContentForAPI`, `buildOpenAIChatPayload`, `buildAnthropicMessagesPayload`

### `packages/mineru/src/assets.ts` (32 行)
- **Functions**: `normalizeAssetKey`, `assetBasename`, `localMarkdownImageTargets`, `extensionFromTarget`, `standardizeAssets`

### `packages/mineru/src/mineru_client.ts` (106 行)
- **Functions**: `short_upload_filename`, `temporary_mineru_upload_file`, `mineruIsSupportedInputFile`, `buildMinerUSubmitPayload`, `normalizeMinerUTask`, `submitMinerUTask`, `pollMinerUTask`, `saveMineruToken`, `loadMineruToken`, `buildMineruDocumentToolAdapter`, `createParseWorker`

### `packages/mineru/src/mineru_zip.ts` (39 行)
- **Functions**: `planZipExtraction`, `identifyMinerURoot`

---

**符号统计**: 涵盖 30 个核心类，34 个类方法，1647 个关键函数/模块方法。