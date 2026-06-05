/**
 * Status and type constants — string-based for cross-language portability.
 */

export const Status = {
  SUCCESS: "success",
  FAILED: "failed",
  OVERLOADED: "overloaded",
  INTERMEDIATE: "intermediate",
  CLIENT_ERROR: "client_error",
} as const;
export type Status = (typeof Status)[keyof typeof Status];

export const Source = {
  RENDER: "render",
  SHORTCUT: "shortcut",
  CACHE: "cache",
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

export const Strategy = {
  RENDER: "render",
  PROGRESSIVE: "progressive",
  EMBEDDED: "embedded",
  FALLBACK: "fallback",
} as const;
export type Strategy = (typeof Strategy)[keyof typeof Strategy];

// ── Thumbnail ────────────────────────────────────────────────────────────

/**
 * Lazy-decoded JPEG thumbnail data.  Hashable by content so it can be
 * used as a Map key for client-side image caches.
 */
export interface Thumbnail {
  /** Stable content hash — use as a Map key for image caching. */
  readonly key: number;
  /** The raw JPEG bytes. */
  readonly bytes: Uint8Array;
  /** Number of bytes in the JPEG payload. */
  readonly length: number;
}

// ── Result ───────────────────────────────────────────────────────────────

/**
 * A thumbnail result for one URL.  The same object is returned for
 * repeated calls with the same URL (fields updated in-place).
 */
export interface Result {
  url: string;
  status: string;
  /** HTTP status from the upstream source fetch, or null. */
  sourceStatus: number | null;
  duration: number;
  downloadSize: number;
  message: string | null;
  strategy: string | null;
  placeholder: string | null;
  mime: string | null;
  fileSize: number | null;
  kind: string | null;
  extension: string | null;
  /** Arbitrary properties from the server (dimensions, etc.). */
  properties: Record<string, unknown>;
  /** Opaque cache token for round-tripping. */
  cache: string | null;
  /** How the thumbnail was produced.  null on failure. */
  source: string | null;
  /** The thumbnail JPEG data. */
  thumbnail: Thumbnail;
  /** Raw server JSON (minus thumbnail for memory). */
  raw: Record<string, unknown>;

  /** True when the epoch in the cache token has not expired. */
  isFresh(): boolean;
  /** True when thumbnail was produced successfully. */
  isSuccess(): boolean;
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
