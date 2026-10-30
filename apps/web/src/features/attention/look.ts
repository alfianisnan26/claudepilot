import type { BadgeTone } from '@isnanme/ui';
import type { AttentionKind, AttentionWhy } from '@portal/contracts';
import { Gauge, GitBranch, PlugZap, PowerOff, Puzzle, Rocket, ShieldCheck, ShieldQuestion, Ticket, UserRound, type LucideIcon } from 'lucide-react';

// How an item looks wherever it is drawn (the list, the deck, the Home widget): one icon per kind, one tone and one InfoTip per why.

export const KIND_ICON: Record<AttentionKind, LucideIcon> = {
  mcp_version: PlugZap,
  skill_version: Puzzle,
  ci_deploy: Rocket,
  ticket_approval: Ticket,
  tool_approval: ShieldQuestion,
  keepgoing_down: PowerOff,
  persona_proposal: UserRound,
  ci_upstream: GitBranch,
  workspace_memory: Gauge,
  approval: ShieldCheck,
};

export const WHY_TONE: Record<AttentionWhy, BadgeTone> = {
  production_uat: 'danger',
  secrets_permissions: 'danger',
  third_party_code: 'warning',
  gate: 'warning',
  question: 'neutral',
};

export const WHY_ABOUT: Record<AttentionWhy, string> = {
  production_uat: 'A deploy to a protected environment waits for a person’s approval.',
  secrets_permissions: 'It grants a secret or a permission.',
  third_party_code: 'Code from outside the portal (an MCP server, a skill) runs only once a person has read it.',
  gate: 'Only a person may let it through: a tool approval held ten minutes or more, or a change to an agent’s persona.',
  question: 'An agent asked a person to decide.',
};
