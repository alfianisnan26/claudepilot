import { emptyPersona, type ContextContent, type PersonaContent } from '@portal/contracts';
import { ScrollText, UserRound } from 'lucide-react';
import { definePoolType } from '@/features/pools/definePoolType';
import { ContextEditor } from './ContextEditor';
import { contextContent, lineCount } from './labels';
import { PersonaAddOn } from './PersonaAddOn';
import { PersonaLeading, PersonaSummary, ProposalsAction } from './PersonaCard';
import { PersonaConfiguration } from './PersonaConfiguration';
import { PersonaEditor } from './PersonaEditor';

/**
 * Personas' tab in the Pools hub (Persona PRD §15, `/admin/pools?tab=personas`): the personas, their editor
 * page, the workspace Configuration row and the one-persona choice in Add-ons. Saves are drafts until published.
 */
export const personasTab = definePoolType<PersonaContent>({
  id: 'personas',
  label: 'Personas',
  type: 'persona',
  noun: { one: 'persona', other: 'personas' },
  description: 'What Claude is told, and where agents start.',
  icon: UserRound,
  emptyContent: emptyPersona,
  Editor: PersonaEditor,
  editor: 'page',
  drafts: true,
  single: true,
  headerAction: <ProposalsAction />,
  Leading: PersonaLeading,
  summary: (p) => <PersonaSummary pool={p} />,
  ConfigurationDetail: PersonaConfiguration,
  AddOn: PersonaAddOn,
  publishNote: (n) => `${n} workspace${n === 1 ? ' gets' : 's get'} this. Open agents re-read the instructions at their next message; the rest applies to new agents.`,
});

/** Instruction contexts' tab (Persona PRD A9, `/admin/pools?tab=contexts`): reusable instructions, assigned on their own or held by personas. */
export const contextsTab = definePoolType<ContextContent>({
  id: 'contexts',
  label: 'Contexts',
  type: 'context',
  noun: { one: 'context', other: 'contexts' },
  description: 'Reusable instructions for workspaces and personas.',
  icon: ScrollText,
  emptyContent: () => ({ body: '' }),
  Editor: ContextEditor,
  editor: 'page',
  drafts: true,
  summary: (p) => {
    const c = contextContent(p);
    const lines = c ? lineCount(c.body) : 0;
    return lines ? `${lines} lines` : 'Empty';
  },
  publishNote: (n) => `${n} workspace${n === 1 ? ' gets' : 's get'} this. Open agents re-read it at their next message.`,
});
