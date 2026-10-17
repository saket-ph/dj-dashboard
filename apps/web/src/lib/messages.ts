import { ApiError } from './api';

/**
 * User-facing copy for failures. Server messages are generic and safe; the UI only adds
 * guidance. Never shows stack traces, SQL, or internals (FR-010, FR-061).
 */
export function describeSubmitError(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case 'NETWORK':
        return 'We could not reach the server. Check your connection and try again. Your details are still filled in.';
      case 'VALIDATION_ERROR':
        return err.message;
      case 'RATE_LIMITED':
        return 'You are sending requests too quickly. Please wait a minute and try again.';
      case 'CONFLICT':
        return 'That request was already sent with different details. Please check the form and submit again.';
      case 'SERVICE_UNAVAILABLE':
        return 'The service is busy right now. Please try again in a moment.';
      case 'PERSISTENCE_ERROR':
        return 'Your request was NOT saved. Please try again in a moment.';
      default:
        return 'Something went wrong and your request was NOT saved. Please try again.';
    }
  }
  return 'Something went wrong and your request was NOT saved. Please try again.';
}

export function describeLoginError(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case 'NETWORK':
        return 'Could not reach the server. Check the connection and try again.';
      case 'RATE_LIMITED':
        return 'Too many failed attempts. Wait a few minutes before trying again.';
      case 'UNAUTHENTICATED':
        return 'Incorrect password.';
      case 'SERVICE_UNAVAILABLE':
        return 'The service is busy. Try again in a moment.';
      default:
        return 'Could not log in. Please try again.';
    }
  }
  return 'Could not log in. Please try again.';
}

export const SESSION_EXPIRED_MESSAGE = 'Your session ended. Please log in again.';

export function describeLoadError(err: unknown): string {
  if (err instanceof ApiError && err.code === 'NETWORK') {
    return 'Could not reach the server, so the queue could not be loaded.';
  }
  return 'The queue could not be loaded.';
}

export function describeDeleteError(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case 'NETWORK':
        return 'Could not reach the server. Nothing was deleted.';
      case 'FORBIDDEN':
        return 'Your session could not be verified. Refresh the page and try again.';
      case 'SERVICE_UNAVAILABLE':
        return 'The service is busy. Nothing was deleted; try again.';
      default:
        return 'The songs were not deleted. Please try again.';
    }
  }
  return 'The songs were not deleted. Please try again.';
}

export function describeActionError(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case 'NETWORK':
        return 'Could not reach the server. The request was not updated.';
      case 'FORBIDDEN':
        return 'Your session could not be verified. Refresh the page and try again.';
      case 'NOT_FOUND':
        return 'That request no longer exists. The queue has been reloaded.';
      case 'VALIDATION_ERROR':
        return 'That status change is not allowed.';
      case 'SERVICE_UNAVAILABLE':
        return 'The service is busy. The request was not updated; try again.';
      default:
        return 'The request was not updated. Please try again.';
    }
  }
  return 'The request was not updated. Please try again.';
}
