// Retain a failed request across page reloads. Storage contains only a digest and random ID.
// A successful save clears the key so an intentional later save is a new operation.
const inFlight = new Map<string, Promise<unknown>>();
export async function customerWriteRequest<T>(action: string, data: Record<string, unknown>, send: (requestId: string) => Promise<T>): Promise<T> {
  if (typeof data.requestId === 'string') return send(data.requestId);
  const canonical = JSON.stringify([action, Object.fromEntries(Object.keys(data).sort().map(key => [key, data[key]]))]);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  const key = 'customer-write:' + Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  const running = inFlight.get(key);
  if (running) return running as Promise<T>;
  const requestId = sessionStorage.getItem(key) || crypto.randomUUID();
  sessionStorage.setItem(key, requestId);
  const promise = (async () => {
    try {
      const result = await send(requestId);
      sessionStorage.removeItem(key);
      return result;
    } finally { inFlight.delete(key); }
  })();
  inFlight.set(key, promise);
  return promise;
}
