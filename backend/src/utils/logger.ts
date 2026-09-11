type LogLevel = 'debug' | 'info' | 'warn' | 'error'

interface LogContext {
  [key: string]: unknown
}

class Logger {
  private isDevelopment = process.env.NODE_ENV === 'development'

  private formatMessage(level: LogLevel, message: string, context?: LogContext): string {
    const timestamp = new Date().toISOString()
    const contextStr = context ? ` ${JSON.stringify(context)}` : ''
    return `[${timestamp}] [${level.toUpperCase()}] ${message}${contextStr}`
  }

  debug(message: string, context?: LogContext): void {
    if (this.isDevelopment) console.debug(this.formatMessage('debug', message, context))
  }

  info(message: string, context?: LogContext): void {
    console.log(this.formatMessage('info', message, context))
  }

  warn(message: string, context?: LogContext): void {
    console.warn(this.formatMessage('warn', message, context))
  }

  error(message: string, error?: Error | unknown, context?: LogContext): void {
    let errorContext: LogContext
    if (error instanceof Error) {
      errorContext = { ...context, error: error.message, stack: this.isDevelopment ? error.stack : undefined }
    } else if (error && typeof error === 'object') {
      const errorObj = error as Record<string, unknown>
      errorContext = { ...context, error: errorObj.message || errorObj.code || JSON.stringify(error) }
    } else if (error !== undefined) {
      errorContext = { ...context, error: String(error) }
    } else {
      errorContext = { ...context }
    }
    console.error(this.formatMessage('error', message, errorContext))
  }
}

export const logger = new Logger()
