/**
 * Standardized error classes for Tracearr API
 * All errors return consistent ApiError format from @tracearr/shared
 */

import type { FastifyInstance, FastifyError } from 'fastify';
import type { ZodError } from 'zod';
import type { ApiError } from '@tracearr/shared';

// Error codes for client identification
export const ErrorCodes = {
  // Authentication (1xxx)
  UNAUTHORIZED: 'AUTH_001',
  INVALID_TOKEN: 'AUTH_002',
  TOKEN_EXPIRED: 'AUTH_003',
  INSUFFICIENT_PERMISSIONS: 'AUTH_004',

  // Validation (2xxx)
  VALIDATION_ERROR: 'VAL_001',
  INVALID_INPUT: 'VAL_002',
  MISSING_FIELD: 'VAL_003',

  // Resource (3xxx)
  NOT_FOUND: 'RES_001',
  ALREADY_EXISTS: 'RES_002',
  CONFLICT: 'RES_003',

  // Server (4xxx)
  INTERNAL_ERROR: 'SRV_001',
  SERVICE_UNAVAILABLE: 'SRV_002',
  DATABASE_ERROR: 'SRV_003',
  REDIS_ERROR: 'SRV_004',

  // Rate limiting (5xxx)
  RATE_LIMITED: 'RATE_001',

  // External services (6xxx)
  PLEX_ERROR: 'EXT_001',
  JELLYFIN_ERROR: 'EXT_002',
  GEOIP_ERROR: 'EXT_003',
  EMBY_ERROR: 'EXT_004',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

/**
 * Base application error class
 */
export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: ErrorCode;
  public readonly isOperational: boolean;
  public readonly details?: Record<string, unknown>;

  constructor(
    message: string,
    statusCode: number,
    code: ErrorCode,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = true;
    this.details = details;

    // Maintains proper stack trace for where error was thrown
    Error.captureStackTrace(this, this.constructor);
    Object.setPrototypeOf(this, AppError.prototype);
  }

  toJSON(): ApiError & { code: ErrorCode; details?: Record<string, unknown> } {
    return {
      statusCode: this.statusCode,
      error: this.name,
      message: this.message,
      code: this.code,
      ...(this.details && { details: this.details }),
    };
  }
}

/**
 * Validation error - 400 Bad Request
 */
export class ValidationError extends AppError {
  public readonly fields?: Array<{ field: string; message: string }>;

  constructor(message: string, fields?: Array<{ field: string; message: string }>) {
    super(message, 400, ErrorCodes.VALIDATION_ERROR, fields ? { fields } : undefined);
    this.name = 'ValidationError';
    this.fields = fields;
    Object.setPrototypeOf(this, ValidationError.prototype);
  }

  static fromZodError(error: ZodError): ValidationError {
    const fields = error.issues.map((issue) => ({
      field: issue.path.join('.'),
      message: issue.message,
    }));
    return new ValidationError('Validation failed', fields);
  }
}

/**
 * Authentication error - 401 Unauthorized
 */
export class AuthenticationError extends AppError {
  constructor(message = 'Authentication required') {
    super(message, 401, ErrorCodes.UNAUTHORIZED);
    this.name = 'AuthenticationError';
    Object.setPrototypeOf(this, AuthenticationError.prototype);
  }
}

/**
 * Authorization error - 403 Forbidden
 */
export class ForbiddenError extends AppError {
  constructor(message = 'Access denied') {
    super(message, 403, ErrorCodes.INSUFFICIENT_PERMISSIONS);
    this.name = 'ForbiddenError';
    Object.setPrototypeOf(this, ForbiddenError.prototype);
  }
}

/**
 * Not found error - 404 Not Found
 */
export class NotFoundError extends AppError {
  constructor(resource = 'Resource', id?: string) {
    const message = id ? `${resource} with ID '${id}' not found` : `${resource} not found`;
    super(message, 404, ErrorCodes.NOT_FOUND);
    this.name = 'NotFoundError';
    Object.setPrototypeOf(this, NotFoundError.prototype);
  }
}

/**
 * Conflict error - 409 Conflict
 */
export class ConflictError extends AppError {
  constructor(message: string) {
    super(message, 409, ErrorCodes.CONFLICT);
    this.name = 'ConflictError';
    Object.setPrototypeOf(this, ConflictError.prototype);
  }
}

/**
 * Rate limit error - 429 Too Many Requests
 */
export class RateLimitError extends AppError {
  public readonly retryAfter?: number;

  constructor(message = 'Too many requests', retryAfter?: number) {
    super(message, 429, ErrorCodes.RATE_LIMITED, retryAfter ? { retryAfter } : undefined);
    this.name = 'RateLimitError';
    this.retryAfter = retryAfter;
    Object.setPrototypeOf(this, RateLimitError.prototype);
  }
}

/**
 * Internal server error - 500 Internal Server Error
 */
export class InternalError extends AppError {
  constructor(message = 'An unexpected error occurred') {
    super(message, 500, ErrorCodes.INTERNAL_ERROR);
    this.name = 'InternalError';
    // Not operational - these are bugs that need investigation
    (this as { isOperational: boolean }).isOperational = false;
    Object.setPrototypeOf(this, InternalError.prototype);
  }
}

/**
 * Database error - 500 Internal Server Error
 */
export class DatabaseError extends AppError {
  constructor(message = 'Database operation failed') {
    super(message, 500, ErrorCodes.DATABASE_ERROR);
    this.name = 'DatabaseError';
    Object.setPrototypeOf(this, DatabaseError.prototype);
  }
}

/**
 * Service unavailable - 503 Service Unavailable
 */
export class ServiceUnavailableError extends AppError {
  constructor(service: string) {
    super(`${service} is currently unavailable`, 503, ErrorCodes.SERVICE_UNAVAILABLE);
    this.name = 'ServiceUnavailableError';
    Object.setPrototypeOf(this, ServiceUnavailableError.prototype);
  }
}

/**
 * External service error (Plex, Jellyfin, Emby, etc.)
 */
export class ExternalServiceError extends AppError {
  constructor(service: 'plex' | 'jellyfin' | 'emby' | 'geoip', message: string) {
    const codeMap: Record<typeof service, ErrorCode> = {
      plex: ErrorCodes.PLEX_ERROR,
      jellyfin: ErrorCodes.JELLYFIN_ERROR,
      emby: ErrorCodes.EMBY_ERROR,
      geoip: ErrorCodes.GEOIP_ERROR,
    };
    const code = codeMap[service];
    super(`${service.charAt(0).toUpperCase() + service.slice(1)} error: ${message}`, 502, code);
    this.name = 'ExternalServiceError';
    Object.setPrototypeOf(this, ExternalServiceError.prototype);
  }
}

/**
 * Register global error handler for Fastify
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError | AppError | Error, request, reply) => {
    // Log the error
    request.log.error(
      {
        err: error,
        requestId: request.id,
        url: request.url,
        method: request.method,
      },
      'Request error'
    );

    // Handle our custom AppError
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send(error.toJSON());
    }

    // Handle Fastify validation errors
    if ('validation' in error && error.validation) {
      const validationError = new ValidationError(
        'Validation failed',
        error.validation.map((v) => ({
          field: v.instancePath || 'unknown',
          message: v.message ?? 'Invalid value',
        }))
      );
      return reply.status(400).send(validationError.toJSON());
    }

    // Handle Fastify sensible errors (unauthorized, forbidden, etc.)
    if ('statusCode' in error && typeof error.statusCode === 'number') {
      const response: ApiError = {
        statusCode: error.statusCode,
        error: error.name || 'Error',
        message: error.message,
      };
      return reply.status(error.statusCode).send(response);
    }

    // Handle unknown errors
    const isProduction = process.env.NODE_ENV === 'production';
    const response: ApiError = {
      statusCode: 500,
      error: 'InternalServerError',
      message: isProduction ? 'An unexpected error occurred' : error.message,
    };

    return reply.status(500).send(response);
  });

  // Handle 404 Not Found
  app.setNotFoundHandler((request, reply) => {
    const response: ApiError = {
      statusCode: 404,
      error: 'NotFound',
      message: `Route ${request.method} ${request.url} not found`,
    };
    return reply.status(404).send(response);
  });
}
