import type { BadgeTone } from '@isnanme/ui';
import type { AttentionKind, AttentionWhy } from '@portal/contracts';
import { PlugZap, PowerOff, Puzzle, Rocket, ShieldQuestion, Ticket, type LucideIcon } from 'lucide-react';

// How an item looks wherever it is drawn (the list, the deck, the Home widget): one icon per kind, one tone and one InfoTip per why.

export const KIND_ICON: Record<AttentionKind, LucideIcon> = {
  mcp_version: PlugZap,
  skill_version: Puzzle,
  ci_deploy: Rocket,
  ticket_approval: Ticket,
  tool_approval: ShieldQuestion,
  keepgoing_down: PowerOff,
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
  gate: 'An agent has waited ten minutes or more for a tool approval.',
  question: 'An agent asked a person to decide.',
};
