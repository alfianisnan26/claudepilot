import { Button, CopyButton, Dialog } from '@isnanme/ui';

/** The signing secret, shown once (it is never returned again). */
export function SecretDialog({ secret, onClose }: { secret: { name: string; value: string } | null; onClose: () => void }) {
  return (
    <Dialog
      open={!!secret}
      onClose={onClose}
      title="Signing secret"
      description={`For ${secret?.name ?? ''}. Copy it now: it is not shown again. Each delivery carries X-Pilot-Signature, an HMAC-SHA256 of the timestamp, a dot and the body.`}
      size="sm"
      footer={<Button onClick={onClose}>Done</Button>}
    >
      <div className="flex items-center gap-2 rounded-xl border border-line bg-surface-2 px-3 py-2.5">
        <code className="min-w-0 flex-1 font-mono text-[13px] break-all select-all">{secret?.value}</code>
        <CopyButton value={secret?.value ?? ''} label="Copy the secret" toastMessage="Secret copied" />
      </div>
    </Dialog>
  );
}
