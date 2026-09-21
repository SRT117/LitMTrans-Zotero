/**
 * Ambient Type Declarations for Zotero & Gecko Host Environments.
 * Exclusively for Serena / TypeScript Language Server semantic analysis.
 * Does not participate in production release artifacts.
 */

// Primary Zotero & Gecko host globals
declare var Zotero: any;
declare var Components: any;
declare var ChromeUtils: any;
declare var Services: any;
declare var PathUtils: any;
declare var IOUtils: any;
declare var Cc: any;
declare var Ci: any;
declare var Cu: any;
declare var Cr: any;

// Additional UI / XPCOM / DOM host globals in Zotero
declare var Zotero_Tabs: any;
declare var XULElement: any;

// External libraries
declare var PDFLib: any;

// LitMTrans Runtime Interface & Namespace
interface LitMTransRuntime {
  Utils?: any;
  Updater?: any;
  PortedCore?: any;
  CAJConverter?: any;
  Storage?: any;
  HTTP?: any;
  DeepSeekWeb?: any;
  EdgeLocalTranslator?: any;
  LayoutTranslationService?: any;
  LayoutHelpers?: any;
  Markdown?: any;
  Mindmap?: any;
  Flowchart?: any;
  Constants?: any;
  ChatInternals?: any;
  LLMService?: any;
  WebMachineTranslationService?: any;
  MinerUService?: any;
  TranslationService?: any;
  ChatService?: any;
  DocumentPipeline?: any;
  FEEDBACK_FORM_URL?: string;
  readerToolbarIconSVG?: any;
  createController?: any;
  Controller?: any;
  ControllerInternals?: any;
  WebMachineTranslation?: any;

  [key: string]: any;
}

declare var LitMTrans: LitMTransRuntime;

declare namespace LitMTrans {
  export let Utils: any;
  export let Updater: any;
  export let PortedCore: any;
  export let CAJConverter: any;
  export let Storage: any;
  export let HTTP: any;
  export let DeepSeekWeb: any;
  export let EdgeLocalTranslator: any;
  export let LayoutTranslationService: any;
  export let FEEDBACK_FORM_URL: string;
}

// Window extension for LitMTrans bridge & state
interface Window {
  LitMTrans?: LitMTransRuntime;
  __LitMTrans_HOST_CALL__?: (...args: any[]) => any;
  __LitMTrans_RECEIVE__?: (...args: any[]) => any;

  wrappedJSObject?: any;

  __mineruInitialFitCache?: any;
  __gallopDisabled?: any;
  __mineruRunLayoutFill?: any;

  [key: string]: any;
}
