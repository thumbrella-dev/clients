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
  /** A registered renderer tried but could not handle this format. */
  FALLBACK: "fallback",
  /** No renderer was registered for this format at all. */
  PLACEHOLDER: "placeholder",
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
 * Binary JPEG thumbnail data.
 *
 * This is the value for the `media.thumbnail` attribute. It can be shared
 * across multiple medias to make placeholder images more efficient.
 *
 * This represents the encoded JPEG data stream. It does not represent pixel
 * or image data itself.
 *
 * There are several accessors to simplify loading the results into various
 * media libraries.
 *
 * Each Thumbrella thumbnail is approximately 5 KB of JPEG data. When the
 * server encodes the image into JSON it uses a base64 encoding. This is
 * handled lazily and automatically by this wrapper.
 *
 * See https://thumbrella.dev/docs/result for full documentation.
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
 * Data from the {@link Result} that describes the source media.
 *
 * Any two results from the same URL that were cached (by either the client
 * or the server) will share the same stable {@link Media} instance for
 * each result.
 *
 * The attributes are mostly mandatory. If the result has a `media`
 * attribute, then these fields will exist.
 *
 * The `properties` represent optional additional information Thumbrella
 * provides to describe the media. Each `kind` has a different schema for
 * what could be included. For example, images will come with
 * `width_pixels`, `height_pixels` and `color_bpp`. But these properties
 * are still optional and may not always be included.
 *
 * The `thumbnail` attribute will always be valid. This is an
 * {@link EncodedJpeg} object that provides several conveniences for
 * accessing the binary encoded image data. This thumbnail data can be
 * shared across multiple instances of {@link Media} objects when it
 * represents placeholder images.
 *
 * Media objects are only created from the {@link Client} as part of
 * a {@link Result}.
 *
 * See https://thumbrella.dev/docs/result for full documentation.
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
 * Result for every URL.
 *
 * The result describes the operation for every thumbnail URL. It handles both
 * successes and failures. There are two levels of fields on the result.
 *
 * The top-level `url` attribute contains the origin URL the request was made
 * for.
 *
 * The `status` attribute is used to help determine how this result should be
 * handled. All statuses will still include an image, even for failures.
 * Comparing the status to the defined values like `Status.SUCCESS` is the
 * best way to handle the status. The {@link Result.verify} method can also
 * be used to return either a successful result, or throw an exception
 * representing the problem.
 *
 * The top-level fields all represent the process of generating the result.
 * These describe if the operation was successful, how caching was involved,
 * and the operations used by either the client or server. Most top-level
 * fields are optionally `null`, and may not be filled in, especially if the
 * result was a failure.
 *
 * The `media` attribute represents all data collected about the media in a
 * {@link Media} value. This describes file size, the mime type, and more.
 *
 * This data is consistent and repeatable. When requesting data that has been
 * cached by either the client or the server, the result will reuse the same
 * media value that has been returned previously.
 *
 * The media also contains a `thumbnail` attribute which represents the JPEG
 * encoded binary data for the thumbnail image.
 *
 * Only the {@link Client} methods generate Result values. They are intended
 * to be immutable and constant. This is the same for the Media attribute.
 *
 * The `raw` attribute represents the raw JSON data returned by the server,
 * although the thumbnail binary data is removed for efficiency.
 *
 * See https://thumbrella.dev/docs/result for full documentation.
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
