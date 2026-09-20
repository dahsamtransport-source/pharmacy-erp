/** OS internet status is not a health check for a database on the same device. */
export function isLoopbackDataApi(
  url = process.env.NEXT_PUBLIC_SUPABASE_URL,
): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return (
      ["http:", "https:"].includes(parsed.protocol) &&
      ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) &&
      !parsed.username &&
      !parsed.password
    );
  } catch {
    return false;
  }
}

// This permits an attempt, not a success indication. RPC errors and idempotency
// still apply when Docker/the local API is down. It is not an offline queue.
export function canAttemptDataRequest(): boolean {
  return (
    typeof navigator === "undefined" || navigator.onLine || isLoopbackDataApi()
  );
}
