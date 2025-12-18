/**
 * Zod validation plugin for Fastify
 * Provides schema validation for request body, query, and params
 */

import type {
  FastifyPluginAsync,
  FastifyRequest,
  FastifyReply,
  preHandlerHookHandler,
} from 'fastify';
import fp from 'fastify-plugin';
import { type z, ZodError } from 'zod';
import { ValidationError } from '../utils/errors.js';

// Validation schema options
export interface ValidationSchemas {
  body?: z.ZodType;
  query?: z.ZodType;
  params?: z.ZodType;
}

declare module 'fastify' {
  interface FastifyInstance {
    validateRequest: (schemas: ValidationSchemas) => preHandlerHookHandler;
  }
}

/**
 * Parse Zod error into field-level errors
 */
function parseZodError(error: ZodError): Array<{ field: string; message: string }> {
  return error.issues.map((issue) => ({
    field: issue.path.join('.') || 'unknown',
    message: issue.message,
  }));
}

const validationPlugin: FastifyPluginAsync = async (app) => {
  /**
   * Create a preHandler that validates request against Zod schemas
   */
  app.decorate('validateRequest', function (schemas: ValidationSchemas): preHandlerHookHandler {
    return function (request: FastifyRequest, _reply: FastifyReply): void {
      const errors: Array<{ field: string; message: string }> = [];

      // Validate body
      if (schemas.body) {
        try {
          const result = schemas.body.parse(request.body);
          // Replace body with parsed/transformed result
          request.body = result;
        } catch (err) {
          if (err instanceof ZodError) {
            errors.push(
              ...parseZodError(err).map((e) => ({
                field: `body.${e.field}`,
                message: e.message,
              }))
            );
          }
        }
      }

      // Validate query
      if (schemas.query) {
        try {
          const result = schemas.query.parse(request.query);
          // Replace query with parsed/transformed result
          request.query = result;
        } catch (err) {
          if (err instanceof ZodError) {
            errors.push(
              ...parseZodError(err).map((e) => ({
                field: `query.${e.field}`,
                message: e.message,
              }))
            );
          }
        }
      }

      // Validate params
      if (schemas.params) {
        try {
          const result = schemas.params.parse(request.params);
          // Replace params with parsed/transformed result
          request.params = result;
        } catch (err) {
          if (err instanceof ZodError) {
            errors.push(
              ...parseZodError(err).map((e) => ({
                field: `params.${e.field}`,
                message: e.message,
              }))
            );
          }
        }
      }

      // If any validation errors, throw ValidationError
      if (errors.length > 0) {
        throw new ValidationError('Validation failed', errors);
      }
    };
  });
};

export default fp(validationPlugin, {
  name: 'validation',
});
