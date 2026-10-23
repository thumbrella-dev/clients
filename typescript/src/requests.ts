// Internal bridge between Client fetches and the browser request manager.
type Listener = (urls: readonly string[]) => void;
const listeners = new WeakMap<object, Set<Listener>>();

export function observeRequests(client: object, listener: Listener): () => void {
  let subscribers = listeners.get(client);
  if (!subscribers) {
    subscribers = new Set();
    listeners.set(client, subscribers);
  }
  subscribers.add(listener);
  return () => {
    subscribers.delete(listener);
    if (subscribers.size === 0) listeners.delete(client);
  };
}

export function notifyRequest(client: object, urls: readonly string[]): void {
  for (const listener of listeners.get(client) ?? []) listener(urls);
}
