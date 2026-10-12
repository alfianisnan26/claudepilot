// Knowledge: one error type for everything the notes layer refuses. It is an AppError (so the routes answer
// with the portal's usual envelope) that also carries a machine `reason`, which the MCP tools hand back as
// their tool-error code (Knowledge PRD §14.1).

import { AppError, type ErrorCode } from '@isnanme/core';

export type KnowledgeReason =
  | 'INVALID_PATH'
  | 'TOO_LARGE'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'EXISTS'
  | 'NOT_UNIQUE'
  | 'NOT_ALLOWED_BY_POLICY'
  | 'VAULT_UNAVAILABLE'
  | 'READ_ONLY'
  | 'SECRET_IN_CONTENT'
  | 'UNSUPPORTED_TYPE'
  | 'INVALID_INPUT'
  | 'LIMIT_REACHED'
  | 'UNAVAILABLE';

const CODE: Record<KnowledgeReason, ErrorCode> = {
  INVALID_PATH: 'VALIDATION_FAILED',
  TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  EXISTS: 'CONFLICT',
  NOT_UNIQUE: 'CONFLICT',
  NOT_ALLOWED_BY_POLICY: 'FORBIDDEN',
  VAULT_UNAVAILABLE: 'FORBIDDEN',
  READ_ONLY: 'FORBIDDEN',
  SECRET_IN_CONTENT: 'VALIDATION_FAILED',
  UNSUPPORTED_TYPE: 'UNSUPPORTED_MEDIA_TYPE',
  INVALID_INPUT: 'VALIDATION_FAILED',
  LIMIT_REACHED: 'LIMIT_REACHED',
  UNAVAILABLE: 'SERVICE_UNAVAILABLE',
};

export class KnowledgeError extends AppError {
  constructor(
    readonly reason: KnowledgeReason,
    message: string,
    details?: unknown,
  ) {
    super(CODE[reason], message, { details: details === undefined ? { reason } : { reason, ...(details as object) } });
  }
}

export const isKnowledgeError = (e: unknown): e is KnowledgeError => e instanceof KnowledgeError;
