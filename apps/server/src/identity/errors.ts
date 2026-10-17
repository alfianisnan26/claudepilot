// The identity error codes (docs/prd/identity-onboarding.md §14), registered once with core's registry the way chat/bypass.ts does.
// REAUTH_REQUIRED is already registered by chat/bypass.ts and is thrown here with its own message.

import { defineErrorCodes } from '@isnanme/core';
import { IDENTITY_ERROR_CODES } from '@portal/contracts';

declare module '@isnanme/core' {
  interface ErrorCodeRegistry {
    SETUP_REQUIRED: true;
    SETUP_DONE: true;
    INVITE_INVALID: true;
    REGISTRATION_CLOSED: true;
    USERNAME_UNAVAILABLE: true;
    LAST_ADMIN: true;
    PASSWORD_REJECTED: true;
    LOCKED_OUT: true;
  }
}

defineErrorCodes({
  [IDENTITY_ERROR_CODES.SETUP_REQUIRED]: { status: 409, message: 'Create the first admin account first.' },
  [IDENTITY_ERROR_CODES.SETUP_DONE]: { status: 404, message: 'Not found.' },
  [IDENTITY_ERROR_CODES.INVITE_INVALID]: { status: 400, message: 'This invitation isn’t valid.' },
  [IDENTITY_ERROR_CODES.REGISTRATION_CLOSED]: { status: 403, message: 'Registration is closed.' },
  [IDENTITY_ERROR_CODES.USERNAME_UNAVAILABLE]: { status: 409, message: 'That username isn’t available.' },
  [IDENTITY_ERROR_CODES.LAST_ADMIN]: { status: 409, message: 'The last admin can’t be removed.' },
  [IDENTITY_ERROR_CODES.PASSWORD_REJECTED]: { status: 422, message: 'Choose another password.' },
  [IDENTITY_ERROR_CODES.LOCKED_OUT]: { status: 429, message: 'Too many tries. Try again later.' },
});

/** The one text every failed sign-in gets (FR19): the page never learns which field was wrong. */
export const SIGN_IN_FAILED = 'That username or password isn’t right.';
