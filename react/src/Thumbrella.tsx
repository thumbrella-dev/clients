import { useEffect, useRef } from "react";
import { initThumbnails } from "./browser.js";

export interface ThumbrellaProps {
  connect?: string;
  lazyLoad?: boolean;
  children: React.ReactNode;
}

export function Thumbrella({ connect, lazyLoad, children }: ThumbrellaProps) {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!rootRef.current) return;
    return initThumbnails(rootRef.current, connect, lazyLoad);
  }, [connect, lazyLoad]);

  return (
    <div ref={rootRef} data-tbr-root data-tbr-connect={connect || ""} data-tbr-lazy={lazyLoad ? "true" : undefined}>
      {children}
    </div>
  );
}
