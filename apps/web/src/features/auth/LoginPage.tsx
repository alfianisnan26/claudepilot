import { Button } from '@isnanme/ui';
import { CODE_LENGTH } from '@portal/contracts';
import { CircleOff } from 'lucide-react';
import { useRef, useState, type FormEvent } from 'react';
import { AuthLayout } from '@/components/AuthLayout';
import { InfoTip } from '@/components/InfoTip';
import { ApiError, errorText } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { ServerCodeInput } from './ServerCodeInput';

export function LoginPage() {
  const { state, login, loginEmail, refresh } = useAuth();
  const enabled = state.status !== 'out' || state.enabled;
  // T-118: with an email account on this portal, email and password come first; the server code stays one tap away.
  const emailFirst = state.status === 'out' && state.emailSignIn;
  const [mode, setMode] = useState<'email' | 'code' | null>(null);
  const useEmail = (mode ?? (emailFirst ? 'email' : 'code')) === 'email';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string>();
  const [formError, setFormError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const input = useRef<{ focus: () => void }>(null);

  const signIn = async (value: string) => {
    if (loading) return;
    setFormError(null);
    if (value.length < CODE_LENGTH) {
      setError(`Enter all ${CODE_LENGTH} characters.`);
      return input.current?.focus();
    }
    setError(undefined);
    setLoading(true);
    try {
      await login(value);
    } catch (err) {
      setLoading(false);
      if (err instanceof ApiError && err.code === 'UNAUTHORIZED') {
        // Wrong code: clear the boxes and put the cursor back for another try.
        setError(err.message);
        setCode('');
      } else if (err instanceof ApiError && err.code === 'FORBIDDEN') void refresh();
      else setFormError(errorText(err, 'Could not sign in.'));
      requestAnimationFrame(() => input.current?.focus());
    }
  };

  const signInEmail = async () => {
    if (loading) return;
    setFormError(null);
    if (!email.trim() || !password) {
      setError('Enter your email and password.');
      return;
    }
    setError(undefined);
    setLoading(true);
    try {
      await loginEmail(email.trim(), password);
    } catch (err) {
      setLoading(false);
      if (err instanceof ApiError && (err.code === 'UNAUTHORIZED' || err.code === 'LOCKED_OUT')) {
        setError(err.message);
        setPassword('');
      } else if (err instanceof ApiError && err.code === 'FORBIDDEN') void refresh();
      else setFormError(errorText(err, 'Could not sign in.'));
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (useEmail) void signInEmail();
    else void signIn(code);
  };

  const field = 'h-12 w-full rounded-2xl border border-line bg-surface px-4 text-[15px] outline-hidden focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-60';

  return (
    <AuthLayout title="Sign in">
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        {!enabled && (
          <div role="status" className="flex items-center gap-2.5 rounded-2xl bg-flame-soft px-4 py-3 text-sm">
            <CircleOff className="size-4 shrink-0 text-flame" />
            <p className="font-semibold">Sign-in is turned off.</p>
            <InfoTip label="How to turn it back on">An admin who is still signed in can turn it back on, or restart the server.</InfoTip>
          </div>
        )}
        {formError && (
          <p role="alert" className="rounded-xl bg-danger-soft px-3.5 py-2.5 text-sm font-medium text-danger">
            {formError}
          </p>
        )}
        {useEmail ? (
          <div className="flex flex-col gap-3">
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-semibold text-ink-soft">Email</span>
              <input type="email" autoComplete="username" inputMode="email" value={email} onChange={(e) => (setEmail(e.target.value), setError(undefined))} disabled={!enabled || loading} autoFocus={enabled} className={field} aria-invalid={!!error} />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-semibold text-ink-soft">Password</span>
              <input type="password" autoComplete="current-password" value={password} onChange={(e) => (setPassword(e.target.value), setError(undefined))} disabled={!enabled || loading} className={field} aria-invalid={!!error} aria-describedby={error ? 'code-error' : undefined} />
            </label>
            {error && (
              <p id="code-error" role="alert" className="text-sm font-medium text-danger">
                {error}
              </p>
            )}
          </div>
        ) : (
        <div className="flex flex-col gap-2">
          <span className="flex items-center gap-1 text-sm font-semibold text-ink-soft">
            Server code
            <InfoTip label="Where is the code?">The code is printed in the server log at startup, or set with PORTAL_SERVER_CODE.</InfoTip>
          </span>
          <ServerCodeInput
            ref={input}
            value={code}
            onChange={(v) => (setCode(v), setError(undefined), setFormError(null))}
            onComplete={(v) => void signIn(v)}
            error={!!error}
            disabled={!enabled || loading}
            autoFocus={enabled}
            describedBy={error ? 'code-error' : undefined}
          />
          {error && (
            <p id="code-error" role="alert" className="text-sm font-medium text-danger">
              {error}
            </p>
          )}
        </div>
        )}
        <Button type="submit" size="lg" loading={loading} disabled={!enabled} className="mt-2 w-full">
          Sign in
        </Button>
        {(emailFirst || mode) && (
          <button
            type="button"
            onClick={() => (setMode(useEmail ? 'code' : 'email'), setError(undefined), setFormError(null))}
            className="press mx-auto min-h-11 px-3 text-sm font-semibold text-ink-soft hover:text-ink"
          >
            {useEmail ? 'Use the server code' : 'Use email'}
          </button>
        )}
      </form>
    </AuthLayout>
  );
}
