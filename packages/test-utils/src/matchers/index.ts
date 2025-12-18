/**
 * Custom Vitest Matchers for Tracearr Tests
 *
 * Domain-specific assertions for cleaner, more readable tests.
 *
 * @module @tracearr/test-utils/matchers
 */

import { expect } from 'vitest';

/**
 * HTTP Response Matchers
 */
interface HTTPMatchers<R = unknown> {
  toHaveStatus(expected: number): R;
  toBeSuccessful(): R;
  toBeClientError(): R;
  toBeServerError(): R;
  toHaveHeader(name: string, value?: string): R;
  toHaveJsonBody(): R;
}

/**
 * Validation Matchers
 */
interface ValidationMatchers<R = unknown> {
  toHaveValidationError(field?: string): R;
  toHaveValidationErrors(count: number): R;
}

/**
 * Date/Time Matchers
 */
interface DateMatchers<R = unknown> {
  toBeWithinSeconds(expected: Date, seconds: number): R;
  toBeRecent(seconds?: number): R;
  toBeBefore(date: Date): R;
  toBeAfter(date: Date): R;
}

/**
 * Array Matchers
 */
interface ArrayMatchers<R = unknown> {
  toContainObjectWith(partial: Record<string, unknown>): R;
  toAllMatch(predicate: (item: unknown) => boolean): R;
  toBeSortedBy(key: string, order?: 'asc' | 'desc'): R;
}

/**
 * UUID Matcher
 */
interface UUIDMatchers<R = unknown> {
  toBeUUID(): R;
}

/**
 * Extend Vitest's expect with custom matchers
 */
declare module 'vitest' {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface Assertion<T>
    extends HTTPMatchers, ValidationMatchers, DateMatchers, ArrayMatchers, UUIDMatchers {}
  interface AsymmetricMatchersContaining
    extends HTTPMatchers, ValidationMatchers, DateMatchers, ArrayMatchers, UUIDMatchers {}
}

/**
 * HTTP response-like object
 */
interface HTTPResponse {
  status?: number;
  statusCode?: number;
  headers?: Record<string, string | string[] | undefined> | Headers;
  body?: unknown;
  json?: () => Promise<unknown>;
}

/**
 * Validation error response
 */
interface ValidationErrorResponse {
  statusCode?: number;
  status?: number;
  error?: string;
  message?: string;
  validation?: {
    body?: Array<{ path: string[]; message: string }>;
    query?: Array<{ path: string[]; message: string }>;
    params?: Array<{ path: string[]; message: string }>;
  };
  issues?: Array<{ path: string[]; message: string }>;
}

/**
 * Install custom matchers
 */
export function installMatchers(): void {
  expect.extend({
    // HTTP Status Matchers
    toHaveStatus(received: HTTPResponse, expected: number) {
      const status = received.status ?? received.statusCode;
      const pass = status === expected;
      return {
        pass,
        message: () =>
          pass
            ? `Expected response not to have status ${expected}, but it did`
            : `Expected response to have status ${expected}, but got ${status}`,
      };
    },

    toBeSuccessful(received: HTTPResponse) {
      const status = received.status ?? received.statusCode ?? 0;
      const pass = status >= 200 && status < 300;
      return {
        pass,
        message: () =>
          pass
            ? `Expected response not to be successful (2xx), but got ${status}`
            : `Expected response to be successful (2xx), but got ${status}`,
      };
    },

    toBeClientError(received: HTTPResponse) {
      const status = received.status ?? received.statusCode ?? 0;
      const pass = status >= 400 && status < 500;
      return {
        pass,
        message: () =>
          pass
            ? `Expected response not to be client error (4xx), but got ${status}`
            : `Expected response to be client error (4xx), but got ${status}`,
      };
    },

    toBeServerError(received: HTTPResponse) {
      const status = received.status ?? received.statusCode ?? 0;
      const pass = status >= 500 && status < 600;
      return {
        pass,
        message: () =>
          pass
            ? `Expected response not to be server error (5xx), but got ${status}`
            : `Expected response to be server error (5xx), but got ${status}`,
      };
    },

    toHaveHeader(received: HTTPResponse, name: string, value?: string) {
      const headers = received.headers;
      if (!headers) {
        return {
          pass: false,
          message: () => `Expected response to have headers, but it has none`,
        };
      }

      let headerValue: string | undefined;
      if (headers instanceof Headers) {
        headerValue = headers.get(name) ?? undefined;
      } else {
        const rawValue = headers[name.toLowerCase()] ?? headers[name];
        headerValue = Array.isArray(rawValue) ? rawValue[0] : rawValue;
      }

      if (value === undefined) {
        const pass = headerValue !== undefined;
        return {
          pass,
          message: () =>
            pass
              ? `Expected response not to have header "${name}", but it did`
              : `Expected response to have header "${name}", but it was missing`,
        };
      }

      const pass = headerValue === value;
      return {
        pass,
        message: () =>
          pass
            ? `Expected header "${name}" not to equal "${value}", but it did`
            : `Expected header "${name}" to equal "${value}", but got "${headerValue}"`,
      };
    },

    toHaveJsonBody(received: HTTPResponse) {
      const headers = received.headers;
      let contentType: string | undefined;

      if (headers instanceof Headers) {
        contentType = headers.get('content-type') ?? undefined;
      } else if (headers) {
        const rawValue = headers['content-type'] ?? headers['Content-Type'];
        contentType = Array.isArray(rawValue) ? rawValue[0] : rawValue;
      }

      const pass = contentType?.includes('application/json') ?? false;
      return {
        pass,
        message: () =>
          pass
            ? `Expected response not to have JSON body, but content-type was "${contentType}"`
            : `Expected response to have JSON body, but content-type was "${contentType}"`,
      };
    },

    // Validation Matchers
    toHaveValidationError(received: ValidationErrorResponse, field?: string) {
      const status = received.status ?? received.statusCode;
      const isValidationError = status === 400 || status === 422;

      if (!isValidationError) {
        return {
          pass: false,
          message: () => `Expected a validation error response (400/422), but got status ${status}`,
        };
      }

      if (!field) {
        return {
          pass: true,
          message: () => `Expected response not to be a validation error, but it was`,
        };
      }

      // Check various validation error formats
      const allIssues = [
        ...(received.validation?.body ?? []),
        ...(received.validation?.query ?? []),
        ...(received.validation?.params ?? []),
        ...(received.issues ?? []),
      ];

      const hasFieldError = allIssues.some((issue) => issue.path.includes(field));

      return {
        pass: hasFieldError,
        message: () =>
          hasFieldError
            ? `Expected no validation error for field "${field}", but found one`
            : `Expected validation error for field "${field}", but none found. Issues: ${JSON.stringify(allIssues)}`,
      };
    },

    toHaveValidationErrors(received: ValidationErrorResponse, count: number) {
      const allIssues = [
        ...(received.validation?.body ?? []),
        ...(received.validation?.query ?? []),
        ...(received.validation?.params ?? []),
        ...(received.issues ?? []),
      ];

      const pass = allIssues.length === count;
      return {
        pass,
        message: () =>
          pass
            ? `Expected not to have ${count} validation errors, but it did`
            : `Expected ${count} validation errors, but got ${allIssues.length}`,
      };
    },

    // Date/Time Matchers
    toBeWithinSeconds(received: Date | string | number, expected: Date, seconds: number) {
      const receivedDate = new Date(received);
      const expectedDate = new Date(expected);
      const diff = Math.abs(receivedDate.getTime() - expectedDate.getTime()) / 1000;
      const pass = diff <= seconds;

      return {
        pass,
        message: () =>
          pass
            ? `Expected date not to be within ${seconds}s of ${expectedDate.toISOString()}, but was ${diff.toFixed(2)}s away`
            : `Expected date to be within ${seconds}s of ${expectedDate.toISOString()}, but was ${diff.toFixed(2)}s away`,
      };
    },

    toBeRecent(received: Date | string | number, seconds = 60) {
      const receivedDate = new Date(received);
      const now = new Date();
      const diff = (now.getTime() - receivedDate.getTime()) / 1000;
      const pass = diff >= 0 && diff <= seconds;

      return {
        pass,
        message: () =>
          pass
            ? `Expected date not to be within ${seconds}s of now, but was ${diff.toFixed(2)}s ago`
            : `Expected date to be within ${seconds}s of now, but was ${diff.toFixed(2)}s ago`,
      };
    },

    toBeBefore(received: Date | string | number, expected: Date) {
      const receivedDate = new Date(received);
      const expectedDate = new Date(expected);
      const pass = receivedDate < expectedDate;

      return {
        pass,
        message: () =>
          pass
            ? `Expected ${receivedDate.toISOString()} not to be before ${expectedDate.toISOString()}`
            : `Expected ${receivedDate.toISOString()} to be before ${expectedDate.toISOString()}`,
      };
    },

    toBeAfter(received: Date | string | number, expected: Date) {
      const receivedDate = new Date(received);
      const expectedDate = new Date(expected);
      const pass = receivedDate > expectedDate;

      return {
        pass,
        message: () =>
          pass
            ? `Expected ${receivedDate.toISOString()} not to be after ${expectedDate.toISOString()}`
            : `Expected ${receivedDate.toISOString()} to be after ${expectedDate.toISOString()}`,
      };
    },

    // Array Matchers
    toContainObjectWith(received: unknown[], partial: Record<string, unknown>) {
      const found = received.some((item) => {
        if (typeof item !== 'object' || item === null) return false;
        const obj = item as Record<string, unknown>;
        return Object.entries(partial).every(([key, value]) => obj[key] === value);
      });

      return {
        pass: found,
        message: () =>
          found
            ? `Expected array not to contain object matching ${JSON.stringify(partial)}`
            : `Expected array to contain object matching ${JSON.stringify(partial)}`,
      };
    },

    toAllMatch(received: unknown[], predicate: (item: unknown) => boolean) {
      const allMatch = received.every(predicate);
      const failingIndex = received.findIndex((item) => !predicate(item));

      return {
        pass: allMatch,
        message: () =>
          allMatch
            ? `Expected not all items to match predicate, but they did`
            : `Expected all items to match predicate, but item at index ${failingIndex} did not`,
      };
    },

    toBeSortedBy(received: unknown[], key: string, order: 'asc' | 'desc' = 'asc') {
      if (received.length < 2) {
        return { pass: true, message: () => 'Array is too short to verify sorting' };
      }

      const getValue = (item: unknown): string | number | undefined => {
        if (typeof item !== 'object' || item === null) return undefined;
        const val = (item as Record<string, unknown>)[key];
        if (typeof val === 'string' || typeof val === 'number') return val;
        return undefined;
      };

      let sorted = true;
      let failedAt = -1;

      for (let i = 1; i < received.length; i++) {
        const prev = getValue(received[i - 1]);
        const curr = getValue(received[i]);

        if (prev === undefined || curr === undefined) continue;
        const comparison = order === 'asc' ? prev > curr : prev < curr;
        if (comparison) {
          sorted = false;
          failedAt = i;
          break;
        }
      }

      return {
        pass: sorted,
        message: () =>
          sorted
            ? `Expected array not to be sorted by "${key}" (${order}), but it was`
            : `Expected array to be sorted by "${key}" (${order}), but failed at index ${failedAt}`,
      };
    },

    // UUID Matcher
    toBeUUID(received: unknown) {
      const uuidRegex =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      const pass = typeof received === 'string' && uuidRegex.test(received);

      return {
        pass,
        message: () =>
          pass
            ? `Expected "${received}" not to be a valid UUID, but it was`
            : `Expected "${received}" to be a valid UUID`,
      };
    },
  });
}

// Export for re-use
export type { HTTPResponse, ValidationErrorResponse };
