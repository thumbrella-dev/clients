/**
 * Request parameters for thumbnail generation.
 */
export interface RunRequest {
  prompt: string;
  metadata?: Record<string, string>;
}

/**
 * Account information including quota and plan details.
 * The `raw` field preserves the unprocessed server response for forward compatibility.
 */
export interface AccountInfo {
  id: string;
  email?: string;
  createdAt?: Date;
  plan?: string;
  token_type?: string;
  raw: Record<string, unknown>;
}

/**
 * Token information for the key used in this request.
 */
export interface TokenInfo {
  token_type: string;
  raw: Record<string, unknown>;
}

/**
 * Response from a text-based thumbnail generation request.
 */
export interface RunResponse {
  requestId: string;
  output: string;
  model?: string;
}

/**
 * Binary image response with content type and raw bytes.
 */
export interface BinaryImageResponse {
  contentType: string;
  data: Uint8Array;
}

/**
 * Server health and version information.
 */
export interface StatusResponse {
  ok: boolean;
  version?: string;
}

/**
 * Event emitted from a streaming generation request.
 */
export interface StreamEvent {
  requestId: string;
  type: string;
  delta?: string;
  done?: boolean;
  error?: string;
}

/**
 * Legacy client configuration object (use connection string constructor instead).
 */
export interface ClientOptions {
  baseUrl: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
}

/** @internal */
interface ConnectionConfig {
  baseUrl: string;
  apiKey?: string;
}

/** @internal */
interface RequestContext {
  baseUrl: string;
  apiKey?: string;
  headers(accept?: string, extra?: HeadersInit): Headers;
  url(path: string): string;
  request(path: string, init?: RequestInit, accept?: string): Request;
}

const DEFAULT_BASE_URL = "https://thumbrella-api.thumbrella.workers.dev";

export function parseConnectionString(input: string, defaultBaseUrl: string = DEFAULT_BASE_URL): ConnectionConfig {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("connection string is empty");
  }

  const value = trimmed.startsWith("tbr:") ? trimmed.slice(4) : trimmed;
  if (!value) {
    throw new Error("connection string is empty after tbr: prefix");
  }

  if (value.startsWith("http://") || value.startsWith("https://")) {
    const comma = value.indexOf(",");
    if (comma < 0) {
      return { baseUrl: value.replace(/\/$/, "") };
    }

    const baseUrl = value.slice(0, comma).trim();
    const apiKey = value.slice(comma + 1).trim();
    if (!baseUrl || !apiKey) {
      throw new Error("invalid connection string: expected 'server,key'");
    }

    return { baseUrl: baseUrl.replace(/\/$/, ""), apiKey };
  }

  if (value.includes(",")) {
    throw new Error("invalid connection string: server must start with http:// or https://");
  }

  return {
    baseUrl: defaultBaseUrl,
    apiKey: value,
  };
}

export function createRequestContext(config: ConnectionConfig): RequestContext {
  const baseUrl = config.baseUrl.replace(/\/$/, "");
  const apiKey = config.apiKey;

  return {
    baseUrl,
    apiKey,
    headers(accept?: string, extra?: HeadersInit): Headers {
      const headers = new Headers(extra);
      if (!headers.has("Content-Type")) {
        headers.set("Content-Type", "application/json");
      }
      if (accept) {
        headers.set("Accept", accept);
      }
      if (apiKey && !headers.has("Authorization")) {
        headers.set("Authorization", `Bearer ${apiKey}`);
      }
      return headers;
    },
    url(path: string): string {
      return `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
    },
    request(path: string, init: RequestInit = {}, accept?: string): Request {
      const headers = this.headers(accept, init.headers);
      return new Request(this.url(path), {
        ...init,
        headers,
      });
    },
  };
}

/**
 * Client for the Thumbrella HTTP API.
 * @example
 * const client = new ThumbrellaClient('api_key_here');
 * const account = await client.getAccount();
 */
export class ThumbrellaClient {
  private readonly context: RequestContext;
  private readonly fetchImpl: typeof fetch;

  /**
   * Create a client from a connection string or legacy options object.
   * @param optionsOrConnection - Connection string (bare key, server URL, or server,key) or ClientOptions object
   * @param fetchImpl - Optional custom fetch implementation (defaults to global fetch)
   */
  constructor(optionsOrConnection: ClientOptions | string, fetchImpl?: typeof fetch) {
    if (typeof optionsOrConnection === "string") {
      this.context = createRequestContext(parseConnectionString(optionsOrConnection));
      this.fetchImpl = fetchImpl ?? fetch;
      return;
    }

    this.context = createRequestContext({
      baseUrl: optionsOrConnection.baseUrl,
      apiKey: optionsOrConnection.apiKey,
    });
    this.fetchImpl = optionsOrConnection.fetchImpl ?? fetch;
  }

  async getAccount(): Promise<AccountInfo> {
    const raw = await this.requestJson<Record<string, unknown>>("/v1/account", { method: "GET" });
    const id = typeof raw.id === "string"
      ? raw.id
      : typeof raw.account_id === "string"
        ? raw.account_id
        : "";

    return {
      id,
      email: typeof raw.email === "string" ? raw.email : undefined,
      createdAt: raw.createdAt ? new Date(String(raw.createdAt)) : undefined,
      plan: typeof raw.plan === "string" ? raw.plan : undefined,
      token_type: typeof raw.token_type === "string" ? raw.token_type : undefined,
      raw,
    };
  }

  async getToken(): Promise<TokenInfo> {
    const raw = await this.requestJson<Record<string, unknown>>("/v1/token", { method: "GET" });
    if (typeof raw.token_type !== "string" || raw.token_type.length === 0) {
      throw new Error("invalid token response: token_type is missing");
    }

    return {
      token_type: raw.token_type,
      raw,
    };
  }

  async getStatus(): Promise<StatusResponse> {
    return this.requestJson<StatusResponse>("/v1/status", { method: "GET" });
  }

  async run(payload: RunRequest): Promise<RunResponse> {
    return this.requestJson<RunResponse>("/v1/run", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  async runImage(payload: RunRequest): Promise<BinaryImageResponse> {
    const response = await this.requestBytes("/v1/run", {
      method: "POST",
      body: JSON.stringify(payload),
    }, "image/jpeg");

    return {
      contentType: response.contentType,
      data: new Uint8Array(response.data),
    };
  }

  async runImageBlob(payload: RunRequest): Promise<Blob> {
    const image = await this.runImage(payload);
    return new Blob([image.data as unknown as BlobPart], { type: image.contentType || "image/jpeg" });
  }

  async *stream(payload: RunRequest): AsyncGenerator<StreamEvent, void, unknown> {
    const response = await this.fetchImpl(this.context.request("/v1/stream", {
      method: "POST",
      body: JSON.stringify(payload),
    }));

    if (!response.ok || !response.body) {
      throw new Error(`stream request failed with status ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      let newlineIndex = buffer.indexOf("\n");

      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);

        if (line.length > 0) {
          yield JSON.parse(line) as StreamEvent;
        }

        newlineIndex = buffer.indexOf("\n");
      }
    }

    const tail = buffer.trim();
    if (tail.length > 0) {
      yield JSON.parse(tail) as StreamEvent;
    }
  }

  private async requestJson<T>(path: string, init: RequestInit): Promise<T> {
    const response = await this.fetchImpl(this.context.request(path, init));

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`request failed with status ${response.status}: ${text}`);
    }

    return (await response.json()) as T;
  }

  private async requestBytes(path: string, init: RequestInit, accept?: string): Promise<{ contentType: string; data: ArrayBuffer }> {
    const response = await this.fetchImpl(this.context.request(path, init, accept));

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`request failed with status ${response.status}: ${text}`);
    }

    return {
      contentType: response.headers.get("content-type") ?? "",
      data: await response.arrayBuffer(),
    };
  }
}
