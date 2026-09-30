import { isAuthApiError, isAuthError, isAuthRetryableFetchError, isAuthSessionMissingError } from '@supabase/supabase-js';

/**
 * True only when an auth error proves there is no usable session (missing, invalid or revoked).
 * Network failures, timeouts and server errors return false: the caller must NOT sign the user
 * out or redirect because of them (the guard app keeps working offline).
 */
export function isDefinitelySignedOut(error: unknown): boolean {
  if (!error) return false;
  if (isAuthRetryableFetchError(error)) return false;
  if (isAuthSessionMissingError(error)) return true;
  if (isAuthApiError(error)) {
    return error.status === 400 || error.status === 401 || error.status === 403 || error.status === 404;
  }
  if (isAuthError(error)) {
    return error.name === 'AuthInvalidJwtError' || error.name === 'AuthInvalidTokenResponseError';
  }
  return false;
}

/** PostgREST / fetch results that mean "could not reach the server" rather than "the server said no". */
export function isNetworkFailure(status: number | undefined, error: unknown): boolean {
  if (status === 0) return true;
  if (typeof status === 'number' && (status >= 500 || status === 408 || status === 429)) return true;
  if (error instanceof TypeError) return true;
  if (isAuthRetryableFetchError(error)) return true;
  const message = error && typeof error === 'object' && 'message' in error ? String((error as { message: unknown }).message) : '';
  return /fetch failed|failed to fetch|networkerror|network request failed|load failed|timed? ?out|ECONN|ENOTFOUND|EAI_AGAIN/i.test(
    message
  );
}
