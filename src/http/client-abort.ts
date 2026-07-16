import type { FastifyReply, FastifyRequest } from 'fastify'

export function createClientAbortSignal(request: FastifyRequest, reply: FastifyReply): {
  signal: AbortSignal
  cleanup: () => void
} {
  const controller = new AbortController()
  const abort = (): void => {
    if (!reply.raw.writableEnded) controller.abort()
  }
  request.raw.once('aborted', abort)
  reply.raw.once('close', abort)
  return {
    signal: controller.signal,
    cleanup: () => {
      request.raw.removeListener('aborted', abort)
      reply.raw.removeListener('close', abort)
    },
  }
}
