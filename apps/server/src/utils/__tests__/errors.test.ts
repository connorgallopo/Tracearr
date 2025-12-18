/**
 * Error Classes Tests
 *
 * Tests the ACTUAL exported error classes and functions from errors.ts:
 * - AppError: Base error class
 * - ValidationError: 400 Bad Request with field details
 * - AuthenticationError: 401 Unauthorized
 * - ForbiddenError: 403 Forbidden
 * - NotFoundError: 404 Not Found
 * - ConflictError: 409 Conflict
 * - RateLimitError: 429 Too Many Requests
 * - InternalError: 500 Internal Server Error
 * - DatabaseError: 500 Database Error
 * - ServiceUnavailableError: 503 Service Unavailable
 * - ExternalServiceError: 502 External Service Error
 * - ErrorCodes: Error code constants
 *
 * These tests validate:
 * - Correct status codes
 * - Correct error codes
 * - toJSON() output format
 * - ValidationError.fromZodError() conversion
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';

// Import ACTUAL production classes and constants - not local duplicates
import {
  AppError,
  ValidationError,
  AuthenticationError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  RateLimitError,
  InternalError,
  DatabaseError,
  ServiceUnavailableError,
  ExternalServiceError,
  ErrorCodes,
  registerErrorHandler,
} from '../errors.js';

describe('ErrorCodes', () => {
  it('should have authentication error codes', () => {
    expect(ErrorCodes.UNAUTHORIZED).toBe('AUTH_001');
    expect(ErrorCodes.INVALID_TOKEN).toBe('AUTH_002');
    expect(ErrorCodes.TOKEN_EXPIRED).toBe('AUTH_003');
    expect(ErrorCodes.INSUFFICIENT_PERMISSIONS).toBe('AUTH_004');
  });

  it('should have validation error codes', () => {
    expect(ErrorCodes.VALIDATION_ERROR).toBe('VAL_001');
    expect(ErrorCodes.INVALID_INPUT).toBe('VAL_002');
    expect(ErrorCodes.MISSING_FIELD).toBe('VAL_003');
  });

  it('should have resource error codes', () => {
    expect(ErrorCodes.NOT_FOUND).toBe('RES_001');
    expect(ErrorCodes.ALREADY_EXISTS).toBe('RES_002');
    expect(ErrorCodes.CONFLICT).toBe('RES_003');
  });

  it('should have server error codes', () => {
    expect(ErrorCodes.INTERNAL_ERROR).toBe('SRV_001');
    expect(ErrorCodes.SERVICE_UNAVAILABLE).toBe('SRV_002');
    expect(ErrorCodes.DATABASE_ERROR).toBe('SRV_003');
    expect(ErrorCodes.REDIS_ERROR).toBe('SRV_004');
  });

  it('should have rate limiting error codes', () => {
    expect(ErrorCodes.RATE_LIMITED).toBe('RATE_001');
  });

  it('should have external service error codes', () => {
    expect(ErrorCodes.PLEX_ERROR).toBe('EXT_001');
    expect(ErrorCodes.JELLYFIN_ERROR).toBe('EXT_002');
    expect(ErrorCodes.GEOIP_ERROR).toBe('EXT_003');
  });
});

describe('AppError', () => {
  it('should create error with correct properties', () => {
    const error = new AppError('Test error', 400, ErrorCodes.VALIDATION_ERROR);

    expect(error.message).toBe('Test error');
    expect(error.statusCode).toBe(400);
    expect(error.code).toBe('VAL_001');
    expect(error.isOperational).toBe(true);
    expect(error.details).toBeUndefined();
  });

  it('should include details when provided', () => {
    const details = { field: 'username', reason: 'too short' };
    const error = new AppError('Validation failed', 400, ErrorCodes.VALIDATION_ERROR, details);

    expect(error.details).toEqual(details);
  });

  it('should be instance of Error', () => {
    const error = new AppError('Test', 400, ErrorCodes.VALIDATION_ERROR);

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(AppError);
  });

  it('should have proper stack trace', () => {
    const error = new AppError('Test', 400, ErrorCodes.VALIDATION_ERROR);

    expect(error.stack).toBeDefined();
    // Stack should contain the test file path (where error was thrown)
    expect(error.stack).toContain('errors.test.ts');
  });

  describe('toJSON', () => {
    it('should return ApiError format without details', () => {
      const error = new AppError('Test error', 400, ErrorCodes.VALIDATION_ERROR);
      const json = error.toJSON();

      expect(json).toEqual({
        statusCode: 400,
        error: 'Error', // Default Error name
        message: 'Test error',
        code: 'VAL_001',
      });
    });

    it('should include details in JSON when present', () => {
      const details = { field: 'email' };
      const error = new AppError('Invalid', 400, ErrorCodes.VALIDATION_ERROR, details);
      const json = error.toJSON();

      expect(json.details).toEqual(details);
    });
  });
});

describe('ValidationError', () => {
  it('should have correct status code and error code', () => {
    const error = new ValidationError('Validation failed');

    expect(error.statusCode).toBe(400);
    expect(error.code).toBe(ErrorCodes.VALIDATION_ERROR);
    expect(error.name).toBe('ValidationError');
  });

  it('should include field details when provided', () => {
    const fields = [
      { field: 'email', message: 'Invalid email format' },
      { field: 'password', message: 'Too short' },
    ];
    const error = new ValidationError('Validation failed', fields);

    expect(error.fields).toEqual(fields);
    expect(error.details).toEqual({ fields });
  });

  it('should be instance of AppError', () => {
    const error = new ValidationError('Test');

    expect(error).toBeInstanceOf(AppError);
    expect(error).toBeInstanceOf(ValidationError);
  });

  describe('fromZodError', () => {
    it('should convert Zod error to ValidationError', () => {
      const schema = z.object({
        email: z.email(),
        age: z.number().min(18),
      });

      const result = schema.safeParse({ email: 'invalid', age: 10 });
      expect(result.success).toBe(false);

      if (!result.success) {
        const error = ValidationError.fromZodError(result.error);

        expect(error).toBeInstanceOf(ValidationError);
        expect(error.message).toBe('Validation failed');
        expect(error.fields).toHaveLength(2);
        expect(error.fields).toContainEqual({
          field: 'email',
          message: expect.any(String),
        });
        expect(error.fields).toContainEqual({
          field: 'age',
          message: expect.any(String),
        });
      }
    });

    it('should handle nested path in Zod errors', () => {
      const schema = z.object({
        user: z.object({
          profile: z.object({
            name: z.string().min(1),
          }),
        }),
      });

      const result = schema.safeParse({ user: { profile: { name: '' } } });
      expect(result.success).toBe(false);

      if (!result.success) {
        const error = ValidationError.fromZodError(result.error);

        expect(error.fields?.[0]?.field).toBe('user.profile.name');
      }
    });
  });
});

describe('AuthenticationError', () => {
  it('should have correct status code and error code', () => {
    const error = new AuthenticationError();

    expect(error.statusCode).toBe(401);
    expect(error.code).toBe(ErrorCodes.UNAUTHORIZED);
    expect(error.name).toBe('AuthenticationError');
  });

  it('should use default message when none provided', () => {
    const error = new AuthenticationError();

    expect(error.message).toBe('Authentication required');
  });

  it('should use custom message when provided', () => {
    const error = new AuthenticationError('Invalid credentials');

    expect(error.message).toBe('Invalid credentials');
  });
});

describe('ForbiddenError', () => {
  it('should have correct status code and error code', () => {
    const error = new ForbiddenError();

    expect(error.statusCode).toBe(403);
    expect(error.code).toBe(ErrorCodes.INSUFFICIENT_PERMISSIONS);
    expect(error.name).toBe('ForbiddenError');
  });

  it('should use default message when none provided', () => {
    const error = new ForbiddenError();

    expect(error.message).toBe('Access denied');
  });

  it('should use custom message when provided', () => {
    const error = new ForbiddenError('Admin access required');

    expect(error.message).toBe('Admin access required');
  });
});

describe('NotFoundError', () => {
  it('should have correct status code and error code', () => {
    const error = new NotFoundError();

    expect(error.statusCode).toBe(404);
    expect(error.code).toBe(ErrorCodes.NOT_FOUND);
    expect(error.name).toBe('NotFoundError');
  });

  it('should use default resource name', () => {
    const error = new NotFoundError();

    expect(error.message).toBe('Resource not found');
  });

  it('should include resource name in message', () => {
    const error = new NotFoundError('User');

    expect(error.message).toBe('User not found');
  });

  it('should include resource ID when provided', () => {
    const error = new NotFoundError('User', 'user-123');

    expect(error.message).toBe("User with ID 'user-123' not found");
  });
});

describe('ConflictError', () => {
  it('should have correct status code and error code', () => {
    const error = new ConflictError('Username already exists');

    expect(error.statusCode).toBe(409);
    expect(error.code).toBe(ErrorCodes.CONFLICT);
    expect(error.name).toBe('ConflictError');
    expect(error.message).toBe('Username already exists');
  });
});

describe('RateLimitError', () => {
  it('should have correct status code and error code', () => {
    const error = new RateLimitError();

    expect(error.statusCode).toBe(429);
    expect(error.code).toBe(ErrorCodes.RATE_LIMITED);
    expect(error.name).toBe('RateLimitError');
  });

  it('should use default message', () => {
    const error = new RateLimitError();

    expect(error.message).toBe('Too many requests');
  });

  it('should include retryAfter when provided', () => {
    const error = new RateLimitError('Rate limit exceeded', 60);

    expect(error.retryAfter).toBe(60);
    expect(error.details).toEqual({ retryAfter: 60 });
  });

  it('should not include retryAfter in details when not provided', () => {
    const error = new RateLimitError('Rate limit exceeded');

    expect(error.retryAfter).toBeUndefined();
    expect(error.details).toBeUndefined();
  });
});

describe('InternalError', () => {
  it('should have correct status code and error code', () => {
    const error = new InternalError();

    expect(error.statusCode).toBe(500);
    expect(error.code).toBe(ErrorCodes.INTERNAL_ERROR);
    expect(error.name).toBe('InternalError');
  });

  it('should NOT be operational (requires investigation)', () => {
    const error = new InternalError();

    expect(error.isOperational).toBe(false);
  });

  it('should use default message', () => {
    const error = new InternalError();

    expect(error.message).toBe('An unexpected error occurred');
  });

  it('should use custom message when provided', () => {
    const error = new InternalError('Something went wrong');

    expect(error.message).toBe('Something went wrong');
  });
});

describe('DatabaseError', () => {
  it('should have correct status code and error code', () => {
    const error = new DatabaseError();

    expect(error.statusCode).toBe(500);
    expect(error.code).toBe(ErrorCodes.DATABASE_ERROR);
    expect(error.name).toBe('DatabaseError');
  });

  it('should use default message', () => {
    const error = new DatabaseError();

    expect(error.message).toBe('Database operation failed');
  });

  it('should use custom message when provided', () => {
    const error = new DatabaseError('Connection timeout');

    expect(error.message).toBe('Connection timeout');
  });
});

describe('ServiceUnavailableError', () => {
  it('should have correct status code and error code', () => {
    const error = new ServiceUnavailableError('Redis');

    expect(error.statusCode).toBe(503);
    expect(error.code).toBe(ErrorCodes.SERVICE_UNAVAILABLE);
    expect(error.name).toBe('ServiceUnavailableError');
  });

  it('should include service name in message', () => {
    const error = new ServiceUnavailableError('Redis');

    expect(error.message).toBe('Redis is currently unavailable');
  });
});

describe('ExternalServiceError', () => {
  it('should use PLEX_ERROR code for plex service', () => {
    const error = new ExternalServiceError('plex', 'Connection refused');

    expect(error.statusCode).toBe(502);
    expect(error.code).toBe(ErrorCodes.PLEX_ERROR);
    expect(error.name).toBe('ExternalServiceError');
    expect(error.message).toBe('Plex error: Connection refused');
  });

  it('should use JELLYFIN_ERROR code for jellyfin service', () => {
    const error = new ExternalServiceError('jellyfin', 'Invalid API key');

    expect(error.code).toBe(ErrorCodes.JELLYFIN_ERROR);
    expect(error.message).toBe('Jellyfin error: Invalid API key');
  });

  it('should use GEOIP_ERROR code for geoip service', () => {
    const error = new ExternalServiceError('geoip', 'Database not found');

    expect(error.code).toBe(ErrorCodes.GEOIP_ERROR);
    expect(error.message).toBe('Geoip error: Database not found');
  });

  it('should use EMBY_ERROR code for emby service', () => {
    const error = new ExternalServiceError('emby', 'Invalid API key');

    expect(error.statusCode).toBe(502);
    expect(error.code).toBe(ErrorCodes.EMBY_ERROR);
    expect(error.name).toBe('ExternalServiceError');
    expect(error.message).toBe('Emby error: Invalid API key');
  });

  it('should capitalize service name in message', () => {
    const plexError = new ExternalServiceError('plex', 'test');
    const jellyfinError = new ExternalServiceError('jellyfin', 'test');
    const embyError = new ExternalServiceError('emby', 'test');
    const geoipError = new ExternalServiceError('geoip', 'test');

    expect(plexError.message).toMatch(/^Plex error:/);
    expect(jellyfinError.message).toMatch(/^Jellyfin error:/);
    expect(embyError.message).toMatch(/^Emby error:/);
    expect(geoipError.message).toMatch(/^Geoip error:/);
  });
});

describe('registerErrorHandler', () => {
  it('should handle AppError correctly', async () => {
    const { default: Fastify } = await import('fastify');
    const app = Fastify({ logger: false });

    registerErrorHandler(app);

    app.get('/test', () => {
      throw new ValidationError('Test validation error', [{ field: 'name', message: 'Required' }]);
    });

    const response = await app.inject({ method: 'GET', url: '/test' });

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.code).toBe(ErrorCodes.VALIDATION_ERROR);
    expect(body.message).toBe('Test validation error');

    await app.close();
  });

  it('should handle Fastify sensible errors', async () => {
    const { default: Fastify } = await import('fastify');
    const { default: sensible } = await import('@fastify/sensible');
    const app = Fastify({ logger: false });

    await app.register(sensible);
    registerErrorHandler(app);

    app.get('/test', (_req, reply) => {
      return reply.unauthorized('Custom unauthorized message');
    });

    const response = await app.inject({ method: 'GET', url: '/test' });

    expect(response.statusCode).toBe(401);
    const body = response.json();
    expect(body.message).toBe('Custom unauthorized message');

    await app.close();
  });

  it('should handle generic errors with statusCode', async () => {
    const { default: Fastify } = await import('fastify');
    const app = Fastify({ logger: false });

    registerErrorHandler(app);

    app.get('/test', () => {
      const err = new Error('Custom error') as Error & { statusCode: number };
      err.statusCode = 418;
      throw err;
    });

    const response = await app.inject({ method: 'GET', url: '/test' });

    expect(response.statusCode).toBe(418);
    const body = response.json();
    expect(body.message).toBe('Custom error');

    await app.close();
  });

  it('should handle unknown errors as 500', async () => {
    const { default: Fastify } = await import('fastify');
    const app = Fastify({ logger: false });

    registerErrorHandler(app);

    app.get('/test', () => {
      throw new Error('Unknown error');
    });

    const response = await app.inject({ method: 'GET', url: '/test' });

    expect(response.statusCode).toBe(500);
    const body = response.json();
    expect(body.error).toBe('InternalServerError');
    // In non-production, shows actual message
    expect(body.message).toBe('Unknown error');

    await app.close();
  });

  it('should handle 404 not found', async () => {
    const { default: Fastify } = await import('fastify');
    const app = Fastify({ logger: false });

    registerErrorHandler(app);

    const response = await app.inject({ method: 'GET', url: '/nonexistent' });

    expect(response.statusCode).toBe(404);
    const body = response.json();
    expect(body.error).toBe('NotFound');
    expect(body.message).toContain('not found');

    await app.close();
  });

  it('should handle Fastify validation errors', async () => {
    const { default: Fastify } = await import('fastify');
    const app = Fastify({ logger: false });

    registerErrorHandler(app);

    // Define a route with JSON schema validation
    app.post(
      '/test',
      {
        schema: {
          body: {
            type: 'object',
            required: ['name', 'email'],
            properties: {
              name: { type: 'string' },
              email: { type: 'string', format: 'email' },
            },
          },
        },
      },
      () => {
        return { ok: true };
      }
    );

    // Send invalid body (missing required fields)
    const response = await app.inject({
      method: 'POST',
      url: '/test',
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.message).toBe('Validation failed');

    await app.close();
  });

  it('should handle validation errors with missing message', async () => {
    const { default: Fastify } = await import('fastify');
    const app = Fastify({ logger: false });

    registerErrorHandler(app);

    // Manually simulate a validation error with missing message
    app.get('/test', () => {
      const err = new Error('Validation error') as Error & {
        validation: Array<{ instancePath: string; message?: string }>;
      };
      err.validation = [
        { instancePath: '/field1', message: undefined },
        { instancePath: '', message: 'Field is required' },
      ];
      throw err;
    });

    const response = await app.inject({ method: 'GET', url: '/test' });

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.details?.fields).toContainEqual({
      field: '/field1',
      message: 'Invalid value',
    });
    expect(body.details?.fields).toContainEqual({
      field: 'unknown',
      message: 'Field is required',
    });

    await app.close();
  });
});

describe('Error hierarchy', () => {
  it('all errors should be instances of Error', () => {
    const errors = [
      new ValidationError('test'),
      new AuthenticationError(),
      new ForbiddenError(),
      new NotFoundError(),
      new ConflictError('test'),
      new RateLimitError(),
      new InternalError(),
      new DatabaseError(),
      new ServiceUnavailableError('test'),
      new ExternalServiceError('plex', 'test'),
    ];

    for (const error of errors) {
      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(AppError);
    }
  });

  it('all errors should have isOperational true except InternalError', () => {
    const operationalErrors = [
      new ValidationError('test'),
      new AuthenticationError(),
      new ForbiddenError(),
      new NotFoundError(),
      new ConflictError('test'),
      new RateLimitError(),
      new DatabaseError(),
      new ServiceUnavailableError('test'),
      new ExternalServiceError('plex', 'test'),
    ];

    for (const error of operationalErrors) {
      expect(error.isOperational).toBe(true);
    }

    expect(new InternalError().isOperational).toBe(false);
  });
});
