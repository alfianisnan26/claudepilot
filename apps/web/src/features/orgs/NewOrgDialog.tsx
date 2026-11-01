import { Button, Dialog, useToast } from '@isnanme/ui';
import { ORG_LIMITS, ORG_SLUG_PATTERN, type Org } from '@portal/contracts';
import { useEffect, useState, type FormEvent } from 'react';
import { InfoTip } from '@/components/InfoTip';
import { api } from '@/lib/api';
import { useOrgs } from './OrgsProvider';
import { orgErrorText, slugFrom } from './rules';

export const orgField = 'h-12 w-full rounded-2xl border border-line bg-surface px-4 text-[15px] outline-hidden focus-visible:ring-2 focus-visible:ring-accent';

/** Creates an org (POST /api/orgs; the server checks the ability). The slug follows the name until it is edited. */
export function NewOrgDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (org: Org) => void }) {
  const toast = useToast();
  const { reload } = useOrgs();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName('');
    setSlug('');
    setSlugEdited(false);
    setError(null);
  }, [open]);

  const slugOk = ORG_SLUG_PATTERN.test(slug);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !slugOk) return;
    setBusy(true);
    setError(null);
    try {
      const org = await api.orgs.create({ name: name.trim(), slug });
      await reload();
      toast('Organization created');
      onCreated(org);
    } catch (err) {
      setError(orgErrorText(err, 'Couldn’t create it.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title="New organization" size="sm">
      <form onSubmit={submit} className="flex flex-col gap-3" noValidate data-new-org="">
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-semibold text-ink-soft">Name</span>
          <input
            type="text"
            autoComplete="organization"
            maxLength={ORG_LIMITS.nameMax}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (!slugEdited) setSlug(slugFrom(e.target.value));
            }}
            className={orgField}
          />
        </label>
        <div className="flex flex-col gap-1.5">
          <span className="flex items-center gap-1 text-sm font-semibold text-ink-soft">
            <label htmlFor="new-org-slug">Slug</label>
            <InfoTip label="About the slug">
              {ORG_LIMITS.slugMin}-{ORG_LIMITS.slugMax} lower-case letters, digits and hyphens. Used in links; it can’t be changed later.
            </InfoTip>
          </span>
          <input
            id="new-org-slug"
            type="text"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={ORG_LIMITS.slugMax}
            value={slug}
            aria-invalid={slug.length > 0 && !slugOk}
            onChange={(e) => {
              setSlugEdited(true);
              setSlug(e.target.value.toLowerCase());
            }}
            className={orgField}
          />
        </div>
        {error && (
          <p role="alert" className="text-sm font-medium [overflow-wrap:anywhere] text-danger">
            {error}
          </p>
        )}
        <Button type="submit" size="lg" loading={busy} disabled={!name.trim() || !slugOk} className="mt-1 w-full">
          Create
        </Button>
      </form>
    </Dialog>
  );
}
