import { Button, isTouchFirst, TextField } from '@isnanme/ui';
import { codeProblem } from '@portal/contracts';
import { CircleOff } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { AuthLayout } from '@/components/AuthLayout';
import { ApiError, errorText } from '@/lib/api';
import { useAuth } from '@/lib/auth';

export function LoginPage() {
  const { state, login, refresh } = useAuth();
  const enabled = state.status !== 'out' || state.enabled;
  const [code, setCode] = useState('');
  const [error, setError] = useState<string>();
  const [formError, setFormError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    const problem = code.trim() ? codeProblem(code) : 'Enter the server code.';
    if (problem) return setError(problem);
    setError(undefined);
    setLoading(true);
    try {
      await login(code);
    } catch (err) {
      setLoading(false);
      if (err instanceof ApiError && err.code === 'UNAUTHORIZED') setError(err.message);
      else if (err instanceof ApiError && err.code === 'FORBIDDEN') void refresh();
      else setFormError(errorText(err, 'Could not sign in.'));
    }
  };

  return (
    <AuthLayout
      title="Sign in"
      subtitle="Enter the server code to manage this portal."
      footer="The code is printed in the server log at startup, or set with PORTAL_SERVER_CODE."
    >
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        {!enabled && (
          <div role="status" className="flex items-start gap-3 rounded-2xl bg-flame-soft px-4 py-3 text-sm">
            <CircleOff className="mt-0.5 size-4 shrink-0 text-flame" />
            <p className="text-ink-soft">
              <span className="font-semibold text-ink">Sign-in is turned off.</span> An admin who is still signed in
              can turn it back on, or restart the server.
            </p>
          </div>
        )}
        {formError && (
          <p role="alert" className="rounded-xl bg-danger-soft px-3.5 py-2.5 text-sm font-medium text-danger">
            {formError}
          </p>
        )}
        <TextField
          label="Server code"
          size="lg"
          placeholder="XXXX-XXXX"
          autoComplete="off"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          className="[&_input]:font-mono [&_input]:uppercase [&_input]:tracking-[0.12em] [&_input]:placeholder:normal-case [&_input]:placeholder:tracking-[0.12em]"
          value={code}
          onChange={(e) => (setCode(e.target.value), setError(undefined))}
          error={error}
          disabled={!enabled}
          autoFocus={enabled && !isTouchFirst()}
        />
        <Button type="submit" size="lg" loading={loading} disabled={!enabled} className="mt-2 w-full">
          Sign in
        </Button>
      </form>
    </AuthLayout>
  );
}
