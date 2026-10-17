import { Button, ChipGroup, FieldGroup, Select, SwitchRow, TextArea, TextField } from '@isnanme/ui';
import { BROWSER_DISPLAYS, type BrowserPoolContent, type BrowserToolRule } from '@portal/contracts';
import { ChevronDown, Plus, Trash2 } from 'lucide-react';
import { addRule, editRule, MAX_HEADER_RULES, removeRule } from './headerRules';
import { RULE_TOOLS } from './tools';
import { InfoTip } from '@/components/InfoTip';
import type { PoolContentEditorProps } from '@/features/pools/types';

const TIERS: { value: BrowserPoolContent['tier']; label: string }[] = [
  { value: 'headless', label: 'Headless' },
  { value: 'browser', label: 'Browser' },
];

const IDLE = [
  { value: '10', label: '10 min' },
  { value: '30', label: '30 min' },
  { value: '120', label: '2 hours' },
  { value: '0', label: 'Never' },
];

const lines = (v: string) => v.split('\n').map((s) => s.trim()).filter(Boolean);

/** A label with its explanation behind an ⓘ (the UI text diet: words go in tips). */
const Tip = ({ label, children }: { label: string; children: string }) => (
  <span className="inline-flex items-center gap-0.5">
    {label}
    <InfoTip label={`About ${label}`}>{children}</InfoTip>
  </span>
);

/**
 * The browser pool's content (browser PRD §15.1): the tier and display first, then what people change
 * rarely. A hidden screen means the proxy view only; a switch a policy overrides is read-only elsewhere.
 */
export function BrowserEditor({ value: c, onChange, errors, disabled }: PoolContentEditorProps<BrowserPoolContent>) {
  const set = <K extends keyof BrowserPoolContent>(key: K, v: BrowserPoolContent[K]) => onChange({ ...c, [key]: v });
  const headless = c.tier === 'headless';

  return (
    <div className="flex flex-col gap-4">
      <ChipGroup
        label={
          <Tip label="Tier">
            Headless: Chromium with no screen, watched through the portal's own preview. Browser: Chromium on a virtual screen you can watch and take over. A Linux desktop tier is not available yet.
          </Tip>
        }
        value={c.tier}
        onChange={(tier) => set('tier', tier)}
        options={TIERS}
        error={errors.tier}
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <Select
          label="Display"
          value={c.display}
          onChange={(v) => set('display', v as BrowserPoolContent['display'])}
          options={BROWSER_DISPLAYS.map((d) => ({ value: d, label: d.replace('x', ' × ') }))}
          disabled={disabled || headless}
          hint={headless ? undefined : 'Best on phones: 1280 × 800'}
          error={errors.display}
        />
        <Select
          label="Sleeps after"
          value={String(c.idleMinutes)}
          onChange={(v) => set('idleMinutes', Number(v))}
          options={IDLE}
          disabled={disabled}
          error={errors.idleMinutes}
        />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <ChipGroup
          label={<Tip label="Profile">Persistent keeps sign-ins in the workspace's home volume. Fresh starts empty every time the browser starts.</Tip>}
          value={c.profile}
          onChange={(v) => set('profile', v)}
          options={[
            { value: 'persistent', label: 'Persistent' },
            { value: 'fresh', label: 'Fresh' },
          ]}
        />
        <ChipGroup
          label={<Tip label="Logins">Shared: every Claude session works in its own tab of one browser, so a sign-in serves them all. Isolated: each session gets a separate profile that is lost when it ends.</Tip>}
          value={c.sessions}
          onChange={(v) => set('sessions', v)}
          options={[
            { value: 'shared', label: 'Shared' },
            { value: 'isolated', label: 'Isolated' },
          ]}
        />
      </div>

      <details className="group rounded-2xl border border-line">
        <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-[13.5px] font-semibold text-ink-soft [&::-webkit-details-marker]:hidden">
          Advanced
          <ChevronDown aria-hidden className="size-4 text-muted transition group-open:rotate-180" />
        </summary>
        <div className="flex flex-col gap-4 border-t border-line p-4">
          <ChipGroup
            label="Starts"
            value={c.start}
            onChange={(v) => set('start', v)}
            options={[
              { value: 'first_use', label: 'On first use' },
              { value: 'with_workspace', label: 'With the workspace' },
            ]}
          />
          <div className="grid gap-3 sm:grid-cols-3">
            <Select label="CPUs" value={String(c.resources.cpus)} onChange={(v) => set('resources', { ...c.resources, cpus: Number(v) })} options={['0.5', '1', '2', '4'].map((v) => ({ value: v, label: v }))} disabled={disabled} error={errors['resources.cpus']} />
            <Select label="Memory" value={String(c.resources.memoryMb)} onChange={(v) => set('resources', { ...c.resources, memoryMb: Number(v) })} options={[1536, 3072, 4096, 8192].map((v) => ({ value: String(v), label: `${v / 1024} GB` }))} disabled={disabled} error={errors['resources.memoryMb']} />
            <Select label="Shared memory" value={String(c.resources.shmMb)} onChange={(v) => set('resources', { ...c.resources, shmMb: Number(v) })} options={[512, 1024, 2048].map((v) => ({ value: String(v), label: `${v / 1024} GB` }))} disabled={disabled} error={errors['resources.shmMb']} />
          </div>
          <div className="flex flex-col gap-2">
            <SwitchRow label="Proxy view" description="A preview the portal draws itself, for any screen." checked={c.proxyView} onChange={(v) => set('proxyView', v)} disabled={disabled || headless} />
            <SwitchRow label="Screen view" description="VNC of the virtual screen." checked={c.liveView && !headless} onChange={(v) => set('liveView', v)} disabled={disabled || headless} />
            <SwitchRow label="Take control" description="People may drive the browser." checked={c.takeOver} onChange={(v) => set('takeOver', v)} disabled={disabled} />
            <SwitchRow label="Private take-over" description="Other viewers see nothing while someone is in control." checked={c.privateTakeOvers} onChange={(v) => set('privateTakeOvers', v)} disabled={disabled} />
            <SwitchRow label="Downloads" description="Saved to ~/Downloads." checked={c.downloads} onChange={(v) => set('downloads', v)} disabled={disabled} />
            <SwitchRow label="Coordinate tools" description="Click, drag and scroll by position." checked={c.vision} onChange={(v) => set('vision', v)} disabled={disabled} />
            <SwitchRow label="DevTools tools" description="Console, network, traces, Lighthouse." checked={c.devtools} onChange={(v) => set('devtools', v)} disabled={disabled} />
            <SwitchRow label="Require sandbox" description="Never start Chrome without its sandbox." checked={c.requireSandbox} onChange={(v) => set('requireSandbox', v)} disabled={disabled} />
          </div>
          <TextArea
            label="Blocked sites"
            hint="One per line: a host, host:port or *.example.com"
            value={c.blockedSites.join('\n')}
            onChange={(e) => set('blockedSites', lines(e.target.value))}
            rows={3}
            error={errors.blockedSites}
            disabled={disabled}
            optional
          />
          <SwitchRow label="Only allowed sites" description="Block everything but the list below." checked={c.allowlistMode} onChange={(v) => set('allowlistMode', v)} disabled={disabled} />
          {c.allowlistMode && (
            <TextArea label="Allowed sites" hint="One per line. Add localhost:<port> for dev servers." value={c.allowedSites.join('\n')} onChange={(e) => set('allowedSites', lines(e.target.value))} rows={3} error={errors.allowedSites} disabled={disabled} />
          )}
          <FieldGroup
            label={
              <Tip label="Headers">
                Headers the browser adds on its own to https requests for the listed hosts (each must be an allowed site). The value comes from a Secrets &amp; env entry at start; only its name is kept here, never the value.
              </Tip>
            }
            error={errors.headers}
          >
            {() => (
              <div className="flex flex-col gap-3">
                {c.headers.map((rule, i) => (
                  <div key={i} className="flex min-w-0 flex-col gap-3 rounded-2xl border border-line p-3">
                    <div className="flex items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <TextField label="Header" autoComplete="off" placeholder="CF-Access-Client-Id" value={rule.name} onChange={(e) => set('headers', editRule(c.headers, i, 'name', e.target.value))} disabled={disabled} />
                      </div>
                      <button
                        type="button"
                        aria-label={`Remove header ${rule.name || i + 1}`}
                        onClick={() => set('headers', removeRule(c.headers, i))}
                        disabled={disabled}
                        className="press mt-6 inline-flex size-11 shrink-0 items-center justify-center rounded-full text-muted hover:text-ink focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-hidden disabled:opacity-60"
                      >
                        <Trash2 aria-hidden className="size-4" />
                      </button>
                    </div>
                    <TextField label="Secret" autoComplete="off" placeholder="Name of a Secrets & env entry" value={rule.secret} onChange={(e) => set('headers', editRule(c.headers, i, 'secret', e.target.value))} disabled={disabled} />
                    <FieldGroup label={<Tip label="Key">The variable to read when the entry is an env file (KEY=VALUE lines). Leave empty to use the entry's whole value. If the variable is missing, the header is left out.</Tip>}>
                      {() => (
                        <input
                          aria-label={`Key of ${rule.name || `header ${i + 1}`}`}
                          autoComplete="off"
                          autoCapitalize="none"
                          spellCheck={false}
                          placeholder="CF_ACCESS_ID"
                          value={rule.key ?? ''}
                          onChange={(e) => set('headers', editRule(c.headers, i, 'key', e.target.value))}
                          disabled={disabled}
                          className="h-11 w-full min-w-0 rounded-xl border border-line bg-surface px-3 font-mono text-[16px] focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-hidden sm:text-[13.5px]"
                        />
                      )}
                    </FieldGroup>
                    <TextArea
                      key={`${i}:${rule.hosts.join(',')}`}
                      label="Hosts"
                      hint="One per line: app.example.com, host:port or *.example.com"
                      defaultValue={rule.hosts.join('\n')}
                      onBlur={(e) => set('headers', editRule(c.headers, i, 'hosts', e.target.value))}
                      rows={2}
                      disabled={disabled}
                    />
                  </div>
                ))}
                {c.headers.length < MAX_HEADER_RULES && (
                  <Button variant="secondary" icon={<Plus className="size-4" />} onClick={() => set('headers', addRule(c.headers))} disabled={disabled} className="self-start">
                    Add header
                  </Button>
                )}
              </div>
            )}
          </FieldGroup>
          <FieldGroup label={<Tip label="Tool rules">Ask: Claude asks before each call. Block: the tool is refused. Default follows Claude Code's own permissions.</Tip>} error={errors.toolRules}>
            {() => (
              <ul className="flex flex-col gap-2">
                {RULE_TOOLS.map((tool) => (
                  <li key={tool} className="flex items-center justify-between gap-3">
                    <span className="min-w-0 truncate font-mono text-[12.5px] text-ink-soft">{tool}</span>
                    <select
                      aria-label={`Rule for ${tool}`}
                      value={c.toolRules[tool] ?? 'default'}
                      onChange={(e) => set('toolRules', { ...c.toolRules, [tool]: e.target.value as BrowserToolRule })}
                      disabled={disabled}
                      className="h-9 rounded-lg border border-line bg-surface px-2 text-[13px]"
                    >
                      <option value="default">Default</option>
                      <option value="ask">Ask</option>
                      <option value="block">Block</option>
                    </select>
                  </li>
                ))}
              </ul>
            )}
          </FieldGroup>
        </div>
      </details>
    </div>
  );
}
