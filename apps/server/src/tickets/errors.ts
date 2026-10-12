import { defineErrorCodes } from '@isnanme/core';

// Codes the tickets module adds to the portal's open error registry.
export const TicketErrors = defineErrorCodes({
  /** An agent's call needs to say which session it is (the workspace has several). */
  SESSION_REQUIRED: { status: 409, message: 'Say which session you are.' },
});

declare module '@isnanme/core' {
  interface ErrorCodeRegistry {
    SESSION_REQUIRED: true;
  }
}
