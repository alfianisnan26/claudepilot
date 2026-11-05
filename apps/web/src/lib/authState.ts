// What the session answer means to the app (D-82 S1a: a member account gets the normal app without the platform areas).

/**
 * `unreachable`: the server didn't answer, which says nothing about whether you are signed in. `in`: signed in; `admin` false for a member
 * account (D-82 S1a: the normal app, without the platform areas; the server decides every call, this only hides what it would refuse).
 * `longCode` (PILOT-1185 slice 2): the server code is a long one, so its field (sign-in and re-auth) is one text field, not the 8 boxes.
 */
export type AuthState =
  | { status: 'loading' }
  | { status: 'out'; enabled: boolean; emailSignIn: boolean; codeOff?: true; longCode?: true }
  | { status: 'in'; admin: boolean; longCode?: true }
  | { status: 'unreachable' };

/** What the session answer says the app is: signed out, an admin's (or the server code's) app, or a member's. */
export function authStateOf(s: { authenticated: boolean; enabled: boolean; member?: boolean; emailSignIn?: boolean; codeSignIn?: boolean; longCode?: boolean }): AuthState {
  const long = s.longCode === true ? { longCode: true as const } : {};
  // Owner request 2026-11-01: `codeOff` when the server code's sign-in is turned off (the page offers accounts only).
  if (!s.authenticated) return { status: 'out', enabled: s.enabled, emailSignIn: !!s.emailSignIn, ...(s.codeSignIn === false ? { codeOff: true as const } : {}), ...long };
  return { status: 'in', admin: !s.member, ...long };
}

/** Whether the signed-in person is a platform admin (a member is not; signed out is not). */
export const isAdminState = (state: AuthState): boolean => state.status === 'in' && state.admin;

/** Whether the server code is a long one (PILOT-1185 slice 2); false while loading or unreachable: the 8 boxes, as before. */
export const longCodeOf = (state: AuthState): boolean => (state.status === 'out' || state.status === 'in') && state.longCode === true;
