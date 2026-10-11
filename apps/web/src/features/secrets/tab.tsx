import type { SecretsContentInput } from '@portal/contracts';
import { LockKeyhole } from 'lucide-react';
import { definePoolType } from '@/features/pools/definePoolType';
import { SecretsAddOn } from './SecretsAddOn';
import { SecretsConfiguration } from './SecretsConfiguration';
import { SecretsEditor } from './SecretsEditor';
import { setSummary } from './summary';

/** Secrets & env's tab in the Pools hub, with its editor page, Configuration row and Add-ons (secrets PRD §12). */
export const secretsTab = definePoolType<SecretsContentInput>({
  id: 'secrets',
  label: 'Secrets',
  type: 'secrets',
  noun: { one: 'secret set', other: 'secret sets' },
  description: 'Variables and secrets for tools in workspaces, as files and environment variables.',
  icon: LockKeyhole,
  emptyContent: () => ({ entries: [] }),
  Editor: SecretsEditor,
  // It holds lists: a page of its own, full screen on phones.
  editor: 'page',
  summary: setSummary,
  ConfigurationDetail: SecretsConfiguration,
  AddOn: SecretsAddOn,
});
