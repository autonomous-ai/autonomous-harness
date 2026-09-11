import type { FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { ValidationError } from '../errors/index.js'

export function validateBody<T extends z.ZodTypeAny>(schema: T) {
  return async (request: FastifyRequest<{ Body: z.infer<T> }>, _reply: FastifyReply): Promise<void> => {
    const result = schema.safeParse(request.body)
    if (!result.success) {
      throw new ValidationError(result.error.issues[0]?.message || 'Invalid request body')
    }
    request.body = result.data as z.infer<T>
  }
}

export function validateParams<T extends z.ZodTypeAny>(schema: T) {
  return async (request: FastifyRequest<{ Params: z.infer<T> }>, _reply: FastifyReply): Promise<void> => {
    const result = schema.safeParse(request.params)
    if (!result.success) {
      throw new ValidationError(result.error.issues[0]?.message || 'Invalid request parameters')
    }
    request.params = result.data as z.infer<T>
  }
}

export function validateQuery<T extends z.ZodTypeAny>(schema: T) {
  return async (request: FastifyRequest<{ Querystring: z.infer<T> }>, _reply: FastifyReply): Promise<void> => {
    const result = schema.safeParse(request.query)
    if (!result.success) {
      throw new ValidationError(result.error.issues[0]?.message || 'Invalid query parameters')
    }
    request.query = result.data as z.infer<T>
  }
}
