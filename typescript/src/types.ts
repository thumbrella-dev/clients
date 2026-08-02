/**
 * Status and type constants, string-based for cross-language portability.
 */

export const Status = {
  SUCCESS: "success",
  FAILED: "failed",
  OVERLOADED: "overloaded",
  INTERMEDIATE: "intermediate",
  /** Server-side only: batch exceeded per-request item limit. */
  BATCHLIMIT: "batchlimit",
  /** Client-side only, server was unreachable. */
  UNAVAILABLE: "unavailable",
} as const;
export type Status = (typeof Status)[keyof typeof Status];

export const Source = {
  RENDER: "render",
  SHORTCUT: "shortcut",
  CACHE: "cache",
  /** Client cache hints were valid, no new thumbnail needed. */
  NOT_MODIFIED: "not_modified",
  /** A registered renderer tried but could not handle this format. */
  FALLBACK: "fallback",
  /** No renderer was registered for this format at all. */
  PLACEHOLDER: "placeholder",
  /** Client-side only, synthetic, not from server. */
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

//  EncodedJpeg 

/**
 * Binary JPEG thumbnail data.
 *
 * This is the value for the `media.thumbnail` attribute. It can be shared
 * across multiple Media objects to make placeholder images more efficient.
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

  /** Stable content hash, use as a Map key for image caching. */
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

//  Media 

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
  /** File-size in bytes from `Content-Length` (0 if unknown). */
  fileSize: number;
  /** Detected media category. */
  kind: string;
  /** Canonical file extension, no dot (e.g. `"jpeg"`, `""` if unknown). */
  extension: string;
  /** Format-specific metadata (dimensions, colour depth, …). */
  properties: Record<string, number>;
  cache: string;
  placeholder: string;

  constructor(data: Record<string, unknown>) {
    this.url = (data.url as string) ?? "";
    this.mime = (data.mime as string) ?? "application/octet-stream";
    this.fileSize = (data.file_size as number) ?? 0;
    this.kind = (data.kind as string) ?? FileKind.UNKNOWN;
    this.extension = (data.extension as string) ?? "";
    this.properties = (data.properties as Record<string, number>) ?? {};
    this.cache = (data.cache as string) ?? "";
    this.placeholder = (data.placeholder as string) ?? "";

    const thumb = data.thumbnail as string | undefined;
    this.thumbnail = (thumb && thumb.length > 0)
      ? new EncodedJpeg({ b64: thumb })
      : new EncodedJpeg({ b64: _FAILED_B64 });
  }

  isFresh(): boolean {
    if (!this.cache) return false;
    const colon = this.cache.indexOf(":");
    if (colon < 0) return false;
    const epoch = parseInt(this.cache.slice(0, colon), 16);
    return epoch > 0 && epoch > Date.now() / 1000;
  }
}

//  Result

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

// Embedded "thumbnail unavailable" placeholder JPEG (250x200, same as failed.jpeg).
const _FAILED_B64 =
  "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" +
  "0FoLQWgtBaC0FoDQWgNBaA0BoDQGggAIED//2Q==";

export class Result {
  url: string;
  status: string;
  message: string | null;
  source: string | null;
  duration: number;
  downloadSize: number;
  httpStatus: number | null;
  media: Media | null;
  raw: Record<string, unknown>;

  constructor(data: Record<string, unknown>) {
    this.url = (data.url as string) ?? "";
    this.status = (data.status as string) ?? Status.UNAVAILABLE;
    this.message = (data.message as string) ?? null;
    this.source = (data.source as string) ?? null;
    this.duration = (data.duration as number) ?? 0;
    this.downloadSize = (data.download_size as number) ?? 0;
    this.httpStatus = (data.http_status as number) ?? null;
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
      media: { file_size: 9, kind: FileKind.UNKNOWN, extension: "", mime: "", thumbnail: _FAILED_B64 },
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

//  Errors

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
