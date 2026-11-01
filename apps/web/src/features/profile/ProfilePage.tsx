import { Button, ConfirmDialog, Segmented, useTheme, useToast, type ThemeChoice } from '@isnanme/ui';
import { FOUNDING_USER_ID, type MyProfile, type MyWebSession, type Org, type PortalToken } from '@portal/contracts';
import { Building2, KeyRound, Laptop, Link2, LogOut, Upload } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Avatar } from '@/components/Avatar';
import { Card } from '@/components/Card';
import { InfoTip } from '@/components/InfoTip';
import { PageHeader } from '@/components/PageHeader';
import { RoleChip, SERVER_CODE_NOTE } from '@/components/AccountMenu';
import { ChangePasswordDialog } from '@/features/auth/ChangePasswordDialog';
import { useOrgs } from '@/features/orgs/OrgsProvider';
import { portalMcpApi } from '@/features/portalmcp/api';
import { api, errorText } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { reloadMe, setMe, useMe } from '@/lib/me';
import { PERSONAL, serializeContext } from '@/lib/orgContext';
import { profileApi } from './api';
import { accountView, deviceLine, initialsOf, linkResult, ORG_ROLE_LABEL, profileSections } from './model';

const field = 'h-12 w-full min-w-0 rounded-2xl border border-line bg-surface px-4 text-[15px] outline-hidden focus-visible:ring-2 focus-visible:ring-accent disabled:bg-surface-2 disabled:text-muted';
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'never');
const THEMES: { value: ThemeChoice; label: string }[] = [
  { value: 'system', label: 'Auto' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

function Section({ id, title, about, children }: { id: string; title: string; about?: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="mb-6" data-profile-section={id}>
      <h2 id={id} className="mb-3 flex items-center gap-1 px-1 text-lg font-semibold text-ink">
        {title}
        {about && <InfoTip label={`About ${title.toLowerCase()}`}>{about}</InfoTip>}
      </h2>
      {children}
    </section>
  );
}

/** One row of a list in a card: text that wraps anywhere, an action at the end. */
function Row({ icon, title, sub, action }: { icon: ReactNode; title: ReactNode; sub?: ReactNode; action?: ReactNode }) {
  return (
    <li className="flex items-center gap-3 px-4 py-3 sm:px-5">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-ink-soft">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5 font-semibold [overflow-wrap:anywhere]">{title}</div>
        {sub && <p className="text-[13px] text-muted [overflow-wrap:anywhere]">{sub}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </li>
  );
}

/**
 * The person's own Profile (owner request 2026-11-01): name, username, picture, email and how they signed in, password, linked sign-ins,
 * the browsers they are signed in on, their organizations, their Portal MCP tokens, and preferences. A server-code session gets a short
 * page pointing to accounts.
 */
export function ProfilePage() {
  const me = useMe();
  const { currentOrg } = useOrgs();
  const sections = profileSections(me);
  const v = accountView(me, currentOrg);
  const profile = me?.kind === 'account' ? me.profile : undefined;

  return (
    <div data-profile-page={me?.kind ?? 'loading'}>
      <PageHeader title="Profile" description="Your account: how you appear, how you sign in, and where you are signed in." />
      {!me && <div className="skeleton h-40 rounded-[24px]" aria-busy="true" />}
      {sections.includes('serverCode') && <ServerCodeCard title={v.title} founder={me?.kind === 'code' ? (me.founder?.displayName ?? null) : null} />}
      {sections.includes('identity') && me?.kind === 'account' && <IdentityCard profile={profile} fallback={me.user} signIn={v.signIn} />}
      {sections.includes('password') && <PasswordCard />}
      {sections.includes('signIns') && profile && <SignInsCard profile={profile} />}
      {sections.includes('devices') && <DevicesCard />}
      {sections.includes('orgs') && <OrgsCard />}
      {sections.includes('tokens') && <TokensCard ownerId={profile?.founder && profile.role === 'admin' ? FOUNDING_USER_ID : (profile?.id ?? (me?.kind === 'account' ? me.user.id : ''))} />}
      {sections.includes('preferences') && <PreferencesCard />}
    </div>
  );
}

function ServerCodeCard({ title, founder }: { title: string; founder: string | null }) {
  const { logout } = useAuth();
  return (
    <Section id="profile-server-code" title="Server code" about={SERVER_CODE_NOTE}>
      <Card className="flex flex-col gap-3 p-4 sm:p-5" data-server-code-card="">
        <p className="font-semibold [overflow-wrap:anywhere]">{title}</p>
        {founder && <p className="text-sm text-muted [overflow-wrap:anywhere]">Acts as {founder}</p>}
        <Button variant="secondary" icon={<LogOut className="size-4" />} onClick={() => void logout()} className="self-start">
          Use an account
        </Button>
      </Card>
    </Section>
  );
}

function IdentityCard({ profile, fallback, signIn }: { profile: MyProfile | undefined; fallback: { displayName: string; email: string; role: 'admin' | 'member' }; signIn: string | null }) {
  const toast = useToast();
  const name0 = profile?.displayName ?? fallback.displayName;
  const [name, setName] = useState(name0);
  const [username, setUsername] = useState(profile?.username ?? '');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setName(profile?.displayName ?? fallback.displayName);
    setUsername(profile?.username ?? '');
  }, [profile?.displayName, profile?.username, fallback.displayName]);
  const dirty = name.trim() !== name0 || username.trim() !== (profile?.username ?? '');
  const picture = profile?.avatar ?? null;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setProblem(null);
    try {
      setMe(await profileApi.update({ displayName: name.trim(), username: username.trim() || null }));
      toast('Saved');
    } catch (err) {
      setProblem(errorText(err, 'Couldn’t save it.'));
    } finally {
      setBusy(false);
    }
  };
  const upload = async (f: File | undefined) => {
    if (!f) return;
    setProblem(null);
    try {
      await profileApi.setAvatar(f);
      await reloadMe();
      toast('Picture changed');
    } catch (err) {
      setProblem(errorText(err, 'Couldn’t use that picture.'));
    } finally {
      if (file.current) file.current.value = '';
    }
  };
  const removePicture = async () => {
    setProblem(null);
    try {
      await profileApi.clearAvatar();
      await reloadMe();
    } catch (err) {
      setProblem(errorText(err, 'Couldn’t remove it.'));
    }
  };

  return (
    <Section id="profile-identity" title="You">
      <Card className="p-4 sm:p-5">
        <div className="mb-4 flex flex-wrap items-center gap-4">
          <Avatar src={picture} initials={initialsOf(name0, profile?.email ?? fallback.email)} className="size-20 text-2xl" />
          <div className="flex flex-wrap gap-2">
            <input ref={file} type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" id="profile-avatar-file" onChange={(e) => void upload(e.target.files?.[0])} />
            <Button variant="secondary" size="sm" icon={<Upload className="size-4" />} onClick={() => file.current?.click()}>
              Upload
            </Button>
            {picture && (
              <Button variant="ghost" size="sm" onClick={removePicture}>
                Remove
              </Button>
            )}
            <InfoTip label="About your picture">PNG, JPEG or WebP, up to 3 MB. It is cropped square. Without one, your initials show.</InfoTip>
          </div>
        </div>
        <form onSubmit={save} className="flex flex-col gap-3" noValidate>
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-semibold text-ink-soft">Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} autoComplete="name" className={field} />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="flex items-center gap-1 text-sm font-semibold text-ink-soft">
              Username
              <InfoTip label="About the username">Optional. 3 to 32 characters: a-z, 0-9, dot, dash or underscore, starting with a letter.</InfoTip>
            </span>
            <input value={username} onChange={(e) => setUsername(e.target.value.toLowerCase())} maxLength={32} autoComplete="username" autoCapitalize="none" spellCheck={false} className={field} />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="flex items-center gap-1 text-sm font-semibold text-ink-soft">
              Email
              <InfoTip label="About the email">You sign in with it. An admin changes it; an SSO provider owns its own.</InfoTip>
            </span>
            <input value={profile?.email ?? fallback.email} readOnly disabled className={field} />
          </label>
          <div className="flex flex-wrap items-center gap-2 text-[13px] text-muted" data-profile-signin="">
            <RoleChip role={(profile?.role ?? fallback.role) === 'admin' ? 'Admin' : 'Member'} />
            {signIn && <span className="[overflow-wrap:anywhere]">{signIn}</span>}
          </div>
          {problem && (
            <p role="alert" className="rounded-xl bg-danger-soft px-3.5 py-2.5 text-sm font-medium [overflow-wrap:anywhere] text-danger">
              {problem}
            </p>
          )}
          <Button type="submit" loading={busy} disabled={!dirty || !name.trim()} className="self-start">
            Save
          </Button>
        </form>
      </Card>
    </Section>
  );
}

function PasswordCard() {
  const [open, setOpen] = useState(false);
  return (
    <Section id="profile-password" title="Password">
      <Card>
        <ul>
          <Row
            icon={<KeyRound className="size-5" />}
            title="Password"
            sub="Changing it signs out your other devices."
            action={
              <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
                Change
              </Button>
            }
          />
        </ul>
      </Card>
      <ChangePasswordDialog open={open} onClose={() => setOpen(false)} />
    </Section>
  );
}

function SignInsCard({ profile }: { profile: MyProfile }) {
  // Owner request 2026-11-01: a link comes back here with `?linked=1` or `?link_error=`; shown once, then dropped from the address.
  const [result] = useState(() => linkResult(window.location.search));
  useEffect(() => {
    if (result) window.history.replaceState(null, '', window.location.pathname);
  }, [result]);
  return (
    <Section id="profile-sign-ins" title="Linked sign-ins" about="Single sign-on providers that sign you in to this account. Link one to sign in with it instead of your password.">
      {result && (
        <p role={result.ok ? 'status' : 'alert'} className={`mb-2 px-1 text-sm ${result.ok ? 'text-ink-soft' : 'text-danger'}`} data-link-result={result.ok ? 'ok' : 'error'}>
          {result.ok ? 'Linked' : result.message}
        </p>
      )}
      <Card>
        <ul className="divide-y divide-line">
          {profile.signIns.map((s) => (
            <Row key={`${s.providerId}`} icon={<Link2 className="size-5" />} title={s.provider} sub={`${s.email} · last used ${when(s.lastUsedAt)}`} />
          ))}
          {(profile.linkable ?? []).map((l) => (
            <Row
              key={`link-${l.providerId}`}
              icon={<Link2 className="size-5" />}
              title={l.provider}
              sub="Not linked"
              action={
                <Button variant="secondary" onClick={() => window.location.assign(l.start)} data-link-provider={l.providerId}>
                  Link
                </Button>
              }
            />
          ))}
        </ul>
      </Card>
    </Section>
  );
}

function DevicesCard() {
  const toast = useToast();
  const [list, setList] = useState<MyWebSession[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const load = useCallback(() => void profileApi.devices().then(setList, (e: unknown) => setProblem(errorText(e, 'Couldn’t load them.'))), []);
  useEffect(load, [load]);
  const end = async (s: MyWebSession) => {
    try {
      await profileApi.endDevice(s.id);
      toast('Signed out');
      load();
    } catch (e) {
      setProblem(errorText(e, 'Couldn’t sign it out.'));
    }
  };
  return (
    <Section id="profile-devices" title="Devices" about="Browsers signed in to your account. Sign out one you no longer use.">
      {problem && <p role="alert" className="mb-2 px-1 text-sm text-danger">{problem}</p>}
      {list === null ? (
        <div className="skeleton h-24 rounded-[24px]" aria-busy="true" />
      ) : (
        <Card>
          <ul className="divide-y divide-line" data-profile-devices="">
            {list.map((s) => {
              const d = deviceLine(s);
              return (
                <Row
                  key={s.id}
                  icon={<Laptop className="size-5" />}
                  title={
                    <>
                      {d.name}
                      {s.current && <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-semibold text-accent">This device</span>}
                    </>
                  }
                  sub={`${d.how ? `${d.how} · ` : ''}since ${when(s.createdAt)}`}
                  action={
                    !s.current && (
                      <Button variant="ghost" size="sm" onClick={() => end(s)} aria-label={`Sign out ${d.name}`}>
                        Sign out
                      </Button>
                    )
                  }
                />
              );
            })}
          </ul>
        </Card>
      )}
    </Section>
  );
}

function OrgsCard() {
  const toast = useToast();
  const { orgs, reload } = useOrgs();
  const [leaving, setLeaving] = useState<Org | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const leave = async () => {
    if (!leaving) return;
    setProblem(null);
    try {
      await api.orgs.leave(leaving.id);
      toast(`Left ${leaving.name}`);
      await reload();
    } catch (e) {
      setProblem(errorText(e, 'Couldn’t leave it.'));
    } finally {
      setLeaving(null);
    }
  };
  return (
    <Section id="profile-orgs" title="Organizations">
      {problem && <p role="alert" className="mb-2 px-1 text-sm text-danger [overflow-wrap:anywhere]">{problem}</p>}
      {orgs && orgs.length === 0 ? (
        <p className="px-1 text-sm text-muted">None</p>
      ) : (
        <Card>
          <ul className="divide-y divide-line">
            {(orgs ?? []).map((o) => (
              <Row
                key={o.id}
                icon={<Building2 className="size-5" />}
                title={o.name}
                sub={ORG_ROLE_LABEL[o.myRole]}
                action={
                  <Button variant="ghost" size="sm" onClick={() => setLeaving(o)}>
                    Leave
                  </Button>
                }
              />
            ))}
          </ul>
        </Card>
      )}
      <ConfirmDialog
        open={!!leaving}
        title="Leave organization?"
        description={leaving ? `You lose access to what ${leaving.name} shares.` : ''}
        confirmLabel="Leave"
        onConfirm={() => void leave()}
        onClose={() => setLeaving(null)}
      />
    </Section>
  );
}

function TokensCard({ ownerId }: { ownerId: string }) {
  const toast = useToast();
  const [tokens, setTokens] = useState<PortalToken[] | null | 'none'>(null);
  const [revoking, setRevoking] = useState<PortalToken | null>(null);
  const load = useCallback(
    () =>
      void portalMcpApi.state().then(
        (s) => setTokens(s.tokens.filter((t) => !t.revokedAt && Date.parse(t.expiresAt) > Date.now() && (t.ownerId ?? FOUNDING_USER_ID) === ownerId)),
        // Not offered to this account (the route refused): no section.
        () => setTokens('none'),
      ),
    [ownerId],
  );
  useEffect(load, [load]);
  if (tokens === 'none') return null;
  const revoke = async () => {
    if (!revoking) return;
    try {
      await portalMcpApi.revokeToken(revoking.id);
      toast('Revoked');
      load();
    } catch (e) {
      toast(errorText(e, 'Couldn’t revoke it.'));
    } finally {
      setRevoking(null);
    }
  };
  return (
    <Section id="profile-tokens" title="MCP tokens" about="Tokens you made for MCP clients. Make new ones in Access → MCP.">
      {tokens === null ? (
        <div className="skeleton h-16 rounded-[24px]" aria-busy="true" />
      ) : tokens.length === 0 ? (
        <p className="px-1 text-sm text-muted">None</p>
      ) : (
        <Card>
          <ul className="divide-y divide-line">
            {tokens.map((t) => (
              <Row
                key={t.id}
                icon={<KeyRound className="size-5" />}
                title={t.label}
                sub={`${t.preview} · ${t.scope} · last used ${when(t.lastUsedAt)}`}
                action={
                  <Button variant="ghost" size="sm" onClick={() => setRevoking(t)}>
                    Revoke
                  </Button>
                }
              />
            ))}
          </ul>
        </Card>
      )}
      <ConfirmDialog
        open={!!revoking}
        title="Revoke token?"
        description={revoking ? `${revoking.label} stops working at once.` : ''}
        confirmLabel="Revoke"
        onConfirm={() => void revoke()}
        onClose={() => setRevoking(null)}
      />
    </Section>
  );
}

function PreferencesCard() {
  const { theme, setTheme } = useTheme();
  const { orgs, context, setContext } = useOrgs();
  return (
    <Section id="profile-preferences" title="Preferences">
      <Card className="flex flex-col gap-4 p-4 sm:p-5">
        <div>
          <p id="profile-theme" className="mb-2 text-sm font-semibold text-ink-soft">
            Theme
          </p>
          <Segmented label="Theme" labelledBy="profile-theme" value={theme} options={THEMES} onChange={setTheme} />
        </div>
        <label className="flex flex-col gap-1.5">
          <span className="flex items-center gap-1 text-sm font-semibold text-ink-soft">
            Context
            <InfoTip label="About the context">Where this device opens: Personal, or one of your organizations. Kept on this device.</InfoTip>
          </span>
          <select
            value={serializeContext(context)}
            onChange={(e) => setContext(e.target.value === 'personal' ? PERSONAL : { kind: 'org', id: e.target.value.slice(4) })}
            className={`${field} font-semibold`}
          >
            <option value="personal">Personal</option>
            {(orgs ?? []).map((o) => (
              <option key={o.id} value={`org:${o.id}`}>
                {o.name}
              </option>
            ))}
          </select>
        </label>
      </Card>
    </Section>
  );
}
