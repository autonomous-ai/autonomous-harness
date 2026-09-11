import type { FastifyReply } from 'fastify'
import type { ApiResponse } from '../types/index.js'

export function sendSuccess<T>(reply: FastifyReply, data: T, statusCode = 200): void {
  const response: ApiResponse<T> = { success: true, data }
  reply.code(statusCode).send(response)
}

export function sendError(reply: FastifyReply, message: string, code: string, statusCode = 500): void {
  const response: ApiResponse<null> = { success: false, error: { code, message } }
  reply.code(statusCode).send(response)
}

export function sendCreated<T>(reply: FastifyReply, data: T): void {
  sendSuccess(reply, data, 201)
}
