namespace LitMTransPort {
  export interface FileStore {
    join(...parts: string[]): string;
    exists(path: string): Promise<boolean>;
    readText(path: string): Promise<string>;
    readBytes(path: string): Promise<Uint8Array>;
    readJSON<T>(path: string, fallback: T): Promise<T>;
    writeText(path: string, value: string): Promise<void>;
    writeBytes(path: string, value: Uint8Array): Promise<void>;
    writeJSON(path: string, value: unknown): Promise<void>;
    makeDirectory(path: string): Promise<void>;
    list(path: string): Promise<string[]>;
    copy(source: string, destination: string): Promise<void>;
    move(source: string, destination: string): Promise<void>;
    remove(path: string, recursive?: boolean): Promise<void>;
  }
  export interface PreferenceStore {
    get<T>(key: string, fallback: T): T;
    set<T>(key: string, value: T): void;
    delete(key: string): void;
  }
  export interface SecretStore {
    has(scope: string, provider: string): boolean;
    get(scope: string, provider: string): string;
    set(scope: string, provider: string, value: string): void;
    delete(scope: string, provider: string): void;
  }
  export interface HttpRequestOptions {
    headers?: Record<string, string>;
    json?: unknown;
    body?: Uint8Array | string;
    timeoutMs?: number;
    signal?: AbortLikeSignal | null;
  }
  export interface HttpClient {
    requestJSON<T>(method: string, url: string, options?: HttpRequestOptions): Promise<T>;
    requestBytes(url: string, options?: HttpRequestOptions): Promise<Uint8Array>;
    upload(url: string, bytes: Uint8Array, options?: HttpRequestOptions): Promise<void>;
    streamSSE(url: string, options: HttpRequestOptions, onEvent: (event: { event: string; data: string }) => boolean | void): Promise<void>;
  }
}
