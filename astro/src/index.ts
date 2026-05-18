import { ThumbrellaClient, type RunRequest } from "@thumbrella/client";

export interface AstroThumbrellaOptions {
  baseUrl: string;
  apiKey?: string;
}

export async function fetchThumbrellaImageBytes(
  options: AstroThumbrellaOptions,
  request: RunRequest,
): Promise<Uint8Array> {
  const client = new ThumbrellaClient({ baseUrl: options.baseUrl, apiKey: options.apiKey });
  const response = await client.runImage(request);
  return response.data;
}
