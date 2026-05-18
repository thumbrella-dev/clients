import { useEffect, useMemo, useState } from "react";
import { ThumbrellaClient, type RunRequest } from "@thumbrella/client";

export interface UseThumbrellaImageOptions {
  baseUrl: string;
  apiKey?: string;
}

export function useThumbrellaImage(options: UseThumbrellaImageOptions, request: RunRequest | null) {
  const client = useMemo(
    () => new ThumbrellaClient({ baseUrl: options.baseUrl, apiKey: options.apiKey }),
    [options.baseUrl, options.apiKey],
  );

  const [blob, setBlob] = useState<Blob | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!request) {
      setBlob(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    void client
      .runImageBlob(request)
      .then((nextBlob) => {
        if (!cancelled) {
          setBlob(nextBlob);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err : new Error("Failed to load image"));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [client, request]);

  return { blob, error, loading };
}
