/**
 * E2E TEST SUPPORT ONLY: `fetch` for Node-side test code (control calls, supabase-js clients in
 * the harness self-tests) that retries when the TCP CONNECT itself failed.
 *
 * On the Windows dev machine a loopback connect occasionally fails with ETIMEDOUT while the
 * machine is busy (seen right after a heavy /__test/reset). A failed connect means the request
 * never reached the server, so repeating it cannot duplicate a write. Any failure after the
 * connection was made (reset, lost response, injected network_error) is NOT retried, so fault
 * injection and "lost response" tests still see exactly what the app would see.
 */

const RETRYABLE_CONNECT_CODES = new Set(['ETIMEDOUT', 'ECONNREFUSED', 'EADDRNOTAVAIL', 'ENETUNREACH']);

/** True only when the error says the TCP connection was never established. */
export function isConnectFailure(error: unknown): boolean {
  const cause = (error as { cause?: { syscall?: unknown; code?: unknown } } | null)?.cause;
  return Boolean(cause && cause.syscall === 'connect' && typeof cause.code === 'string' && RETRYABLE_CONNECT_CODES.has(cause.code));
}

export const CONNECT_RETRY_ATTEMPTS = 4;

export const retryFetch: typeof fetch = async (input, init) => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fetch(input, init);
    } catch (error) {
      if (attempt >= CONNECT_RETRY_ATTEMPTS || !isConnectFailure(error)) throw error;
      const code = (error as { cause?: { code?: string } }).cause?.code;
      console.warn(`[e2e] connect failed (${code}) for ${String(input instanceof Request ? input.url : input)}; retry ${attempt}`);
      await new Promise((resolve) => setTimeout(resolve, 150 * attempt));
    }
  }
};
