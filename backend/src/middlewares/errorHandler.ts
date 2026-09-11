import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify'
import { AppError } from '../errors/index.js'
import { sendError } from '../utils/response.js'
import { logger } from '../utils/logger.js'

export async function errorHandler(
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  if (error instanceof AppError) {
    logger.warn('Application error', {
      code: error.code,
      statusCode: error.statusCode,
      path: request.url,
      method: request.method,
      message: error.message,
    })
    sendError(reply, error.message, error.code || 'APP_ERROR', error.statusCode)
    return
  }

  if (error.validation) {
    sendError(reply, error.validation[0]?.message || 'Validation failed', 'VALIDATION_ERROR', 400)
    return
  }

  // Fastify's own client errors (malformed JSON, unsupported media type, body too large) carry a 4xx
  // statusCode. Logging those at ERROR as "unhandled" buries real server faults in caller noise, and
  // reporting them as INTERNAL_ERROR tells the caller the wrong thing about whose fault it is.
  const status = error.statusCode ?? 500
  if (status >= 400 && status < 500) {
    logger.warn('Client error', {
      code: error.code, statusCode: status, path: request.url, method: request.method, message: error.message,
    })
    sendError(reply, error.message || 'Bad request', error.code || 'BAD_REQUEST', status)
    return
  }

  logger.error('Unhandled error', error, { name: error.name, path: request.url, method: request.method })
  // Only hide the real message in explicit production. Local dev often has NODE_ENV unset, and masking
  // there just surfaces a useless "internal server error" to the caller (e.g. the UI toast).
  const hideDetail = process.env.NODE_ENV === 'production'
  sendError(reply, hideDetail ? 'An internal server error occurred' : (error.message || 'Internal error'), 'INTERNAL_ERROR', error.statusCode || 500)
}
