export interface ThumbnailProps {
  src: string;
  alt?: string;
  className?: string;
  lazyLoad?: boolean;
}

const placeholder =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 3"><rect fill="#e0e0e0" width="4" height="3"/></svg>',
  );

export function Thumbnail({ src, alt = "", className = "", lazyLoad }: ThumbnailProps) {
  return (
    <div
      className={("tbr-wrap " + className).trim() || undefined}
      data-tbr-url={src}
      data-tbr-lazy={lazyLoad != null ? String(lazyLoad) : undefined}
    >
      <img src={placeholder} alt={alt} loading="lazy" decoding="async" />
      <img className="tbr-final" src="" alt="" loading="lazy" decoding="async" />
      <div className="tbr-spinner" aria-hidden="true" />
    </div>
  );
}
