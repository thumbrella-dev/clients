export interface RunRequest {
  prompt: string;
  metadata?: Record<string, string>;
}

export interface RunResponse {
  requestId: string;
  output: string;
  model?: string;
}

export interface BinaryImageResponse {
  contentType: string;
  data: Uint8Array;
}

export interface StatusResponse {
  ok: boolean;
  version?: string;
}

export interface StreamEvent {
  requestId: string;
  type: string;
  delta?: string;
  done?: boolean;
  error?: string;
}

export interface ClientOptions {
  baseUrl: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
}

export class ThumbrellaClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
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
    return new Blob([image.data], { type: image.contentType || "image/jpeg" });
  }

  async *stream(payload: RunRequest): AsyncGenerator<StreamEvent, void, unknown> {
    const response = await this.fetchImpl(`${this.baseUrl}/v1/stream`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(payload),
    });

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
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers: this.headers(),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`request failed with status ${response.status}: ${text}`);
    }

    return (await response.json()) as T;
  }

  private async requestBytes(path: string, init: RequestInit, accept?: string): Promise<{ contentType: string; data: ArrayBuffer }> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers: this.headers(accept),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`request failed with status ${response.status}: ${text}`);
    }

    return {
      contentType: response.headers.get("content-type") ?? "",
      data: await response.arrayBuffer(),
    };
  }

  private headers(accept?: string): HeadersInit {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (accept) {
      headers.Accept = accept;
    }

    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }

    return headers;
  }
}
