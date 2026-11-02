import type { FastifyReply } from 'fastify';
import type { ApiError, ApiErrorCode } from '../shared/types.js';

export function sendError(reply: FastifyReply, status: number, error: ApiErrorCode, message: string): FastifyReply {
  const body: ApiError = { error, message };
  return reply.code(status).send(body);
}
