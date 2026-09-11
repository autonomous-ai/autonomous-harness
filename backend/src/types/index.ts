import type { AuthUser } from '../lib/ssoAuth.js'

export interface ApiResponse<T> {
  success: boolean
  data?: T
  error?: { code: string; message: string }
}

// The internal identity resolved from the SSO access token by the auth middleware.
declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthUser
  }
}
