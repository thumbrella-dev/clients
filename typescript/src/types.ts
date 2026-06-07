/**
 * Status and type constants — string-based for cross-language portability.
 */

export const Status = {
  SUCCESS: "success",
  FAILED: "failed",
  OVERLOADED: "overloaded",
  INTERMEDIATE: "intermediate",
  /** Client-side only — server was unreachable. */
  UNAVAILABLE: "unavailable",
} as const;
export type Status = (typeof Status)[keyof typeof Status];

export const Source = {
  RENDER: "render",
  SHORTCUT: "shortcut",
  CACHE: "cache",
  /** Client cache hints were valid — no new thumbnail needed. */
  NOT_MODIFIED: "not_modified",
  /** Server fell back to a placeholder icon. */
  FALLBACK: "fallback",
  /** Client-side only — synthetic, not from server. */
  CLIENT: "client",
} as const;
export type Source = (typeof Source)[keyof typeof Source];

export const FileKind = {
  IMAGE: "image",
  VIDEO: "video",
  AUDIO: "audio",
  VECTOR: "vector",
  DOCUMENT: "document",
  GEOMETRY: "geometry",
  ARCHIVE: "archive",
  TEXT: "text",
  BINARY: "binary",
  UNKNOWN: "unknown",
} as const;
export type FileKind = (typeof FileKind)[keyof typeof FileKind];

// ── EncodedJpeg ──────────────────────────────────────────────────────────

/**
 * Lazy-decoded JPEG thumbnail data.  Hashable by content so it can be
 * used as a Map key for client-side image caches.
 */
export class EncodedJpeg {
  private _data: Uint8Array | null;
  private _b64: string | null;
  private _hash: number | null = null;

  constructor(opts: { b64?: string; data?: Uint8Array }) {
    this._b64 = opts.b64 ?? null;
    this._data = opts.data ?? null;
  }

  /** The raw JPEG bytes (base64-decoded lazily). */
  get bytes(): Uint8Array {
    if (this._data === null) {
      if (this._b64) {
        const binary = atob(this._b64);
        this._data = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
          this._data[i] = binary.charCodeAt(i);
        }
      } else {
        this._data = new Uint8Array(0);
      }
      this._b64 = null;
    }
    return this._data;
  }

  /** Number of bytes in the JPEG payload. */
  get length(): number {
    if (this._data !== null) return this._data.length;
    if (this._b64) {
      const pad = (this._b64.match(/=+$/) ?? [""])[0].length;
      return Math.floor((this._b64.length * 3) / 4) - pad;
    }
    return 0;
  }

  /** Stable content hash — use as a Map key for image caching. */
  get key(): number {
    if (this._hash === null) {
      const b = this.bytes;
      let h = 0;
      for (let i = 0; i < b.length; i++) {
        h = ((h << 5) - h + b[i]) | 0;
      }
      this._hash = h;
    }
    return this._hash;
  }
}

// ── Media ────────────────────────────────────────────────────────────────

/**
 * Stable media identity — reusable, cacheable payload.
 */
export class Media {
  url: string;
  thumbnail: EncodedJpeg;
  mime: string;
  fileSize: number;
  kind: string;
  extension: string;
  properties: Record<string, number>;
  cache: string | null;

  constructor(data: Record<string, unknown>) {
    this.url = (data.url as string) ?? "";
    this.mime = (data.mime as string) ?? "application/octet-stream";
    this.fileSize = (data.file_size as number) ?? 0;
    this.kind = (data.kind as string) ?? FileKind.UNKNOWN;
    this.extension = (data.extension as string) ?? "";
    this.properties = (data.properties as Record<string, number>) ?? {};
    this.cache = (data.cache as string) ?? null;

    const thumb = data.thumbnail as string | undefined;
    this.thumbnail = thumb
      ? new EncodedJpeg({ b64: thumb })
      : new EncodedJpeg({ data: new Uint8Array(0) });
  }

  isFresh(): boolean {
    if (!this.cache) return false;
    const colon = this.cache.indexOf(":");
    if (colon < 0) return false;
    const epoch = parseInt(this.cache.slice(0, colon), 16);
    return epoch > 0 && epoch > Date.now() / 1000;
  }
}

// ── Result ───────────────────────────────────────────────────────────────

/**
 * A single thumbnail request outcome — process fields + stable media.
 */
export class Result {
  url: string;
  status: string;
  message: string | null;
  source: string | null;
  duration: number;
  downloadSize: number;
  placeholder: string | null;
  media: Media | null;
  raw: Record<string, unknown>;

  constructor(data: Record<string, unknown>) {
    this.url = (data.url as string) ?? "";
    this.status = (data.status as string) ?? Status.UNAVAILABLE;
    this.message = (data.message as string) ?? null;
    this.source = (data.source as string) ?? null;
    this.duration = (data.duration as number) ?? 0;
    this.downloadSize = (data.download_size as number) ?? 0;
    this.placeholder = (data.placeholder as string) ?? null;
    this.raw = data;

    const mediaRaw = data.media as Record<string, unknown> | undefined;
    this.media = mediaRaw ? new Media(mediaRaw) : null;
  }

  static clientFail(url: string, message: string): Result {
    return new Result({
      url,
      status: Status.UNAVAILABLE,
      source: Source.CLIENT,
      message,
    });
  }

  isSuccess(): boolean {
    return this.status === Status.SUCCESS;
  }

  isFresh(): boolean {
    return this.media?.isFresh() ?? false;
  }

  verify(): this {
    if (this.status === Status.SUCCESS) return this;
    throw new ThumbError(
      `thumbnail failed for ${this.url}: ${this.status}` +
        (this.message ? ` — ${this.message}` : ""),
    );
  }
}

// ── Errors ───────────────────────────────────────────────────────────────

export class ThumbError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ThumbError";
  }
}

export class VerifyError extends ThumbError {
  constructor(message: string) {
    super(message);
    this.name = "VerifyError";
  }
}

export class ConnectionError extends ThumbError {
  constructor(message: string) {
    super(message);
    this.name = "ConnectionError";
  }
}

export class TimeoutError extends ThumbError {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}
