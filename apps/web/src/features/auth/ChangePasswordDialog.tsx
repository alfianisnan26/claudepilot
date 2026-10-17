import { Button, Dialog, useToast } from '@isnanme/ui';
import { PASSWORD } from '@portal/contracts';
import { useState, type FormEvent } from 'react';
import { InfoTip } from '@/components/InfoTip';
import { api, errorText } from '@/lib/api';

const field = 'h-12 w-full rounded-2xl border border-line bg-surface px-4 text-[15px] outline-none focus-visible:ring-2 focus-visible:ring-accent';

/** Change your own password (owner, 2026-10-17, gap 3): the current one, then the new one; your other devices are signed out. */
export function ChangePasswordDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setProblem(null);
    try {
      await api.changeMyPassword(current, next);
      toast('Password changed. Your other devices are signed out.');
      setCurrent('');
      setNext('');
      onClose();
    } catch (err) {
      setProblem(errorText(err, 'Couldn’t change it.'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onClose={onClose} title="Change password" size="sm">
      <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-semibold text-ink-soft">Current password</span>
          <input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} className={field} />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="flex items-center gap-1 text-sm font-semibold text-ink-soft">
            New password
            <InfoTip label="Password rules">At least {PASSWORD.min} characters; not a common password and not your email.</InfoTip>
          </span>
          <input type="password" autoComplete="new-password" minLength={PASSWORD.min} value={next} onChange={(e) => setNext(e.target.value)} className={field} />
        </label>
        {problem && (
          <p role="alert" className="rounded-xl bg-danger-soft px-3.5 py-2.5 text-sm font-medium text-danger">
            {problem}
          </p>
        )}
        <Button type="submit" size="lg" loading={busy} className="mt-1 w-full">
          Change password
        </Button>
      </form>
    </Dialog>
  );
}
