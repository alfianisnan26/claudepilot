import type { MultiPoolType, PoolSummary, Workspace, WorkspacePoolAssignment } from '@portal/contracts';
import type { LucideIcon } from 'lucide-react';
import type { ComponentType, ReactNode } from 'react';

/** What a pool type's content editor gets inside the shared editor, which owns name, description, revision note and Preview. */
export interface PoolContentEditorProps<C = unknown> {
  /** The content being edited: the API's view of the newest revision, or `emptyContent()` for a new pool. */
  value: C;
  onChange: (next: C) => void;
  /** Field errors from the last save (the API's `details`), by field. */
  errors: Record<string, string>;
  /** The pool being edited; null for a new one. */
  pool: PoolSummary | null;
  /** The name as typed in the editor now (a new skillset's prefix follows it). */
  name?: string;
  /** True while saving. */
  disabled: boolean;
  /** Where the editor sits: a dialog, or a page of its own for long editors. */
  layout: 'dialog' | 'page';
  /** Loads the pool again: after something saved it from inside the editor (a secret's rotation). */
  reload?: () => void;
  /** The editor holds changes that aren't saved yet. */
  dirty?: boolean;
}

/** The shared UI a multi-assignment pool type plugs into (foundation PRD §10). */
export interface MultiPoolUi<C = unknown> {
  /** The server's pool type. */
  type: MultiPoolType;
  /** For copy such as "New secret set" and "No secret sets yet". */
  noun: { one: string; other: string };
  /** One short sentence under the tab's heading. */
  description: string;
  icon: LucideIcon;
  /** What a new pool's editor starts from: valid input for the server's `parse`. */
  emptyContent: () => C;
  /** The type's part of the shared editor. */
  Editor: ComponentType<PoolContentEditorProps<C>>;
  /** 'dialog' (the default), or 'page' for editors that hold lists (Web app PRD §9.2 `task` routes). */
  editor?: 'dialog' | 'page';
  /**
   * Beside "New …" in the tab's header: links to the type's own pages, such as MCP's Catalog. A function is told whether
   * the tab has pools yet: the header's "New" shows only then, and an action that the empty state shows instead (`emptyAction`)
   * can stay out of the header until there are some.
   */
  headerAction?: ReactNode | ((state: { hasPools: boolean }) => ReactNode);
  /** Beside "New …" in the empty state, such as MCP's Built-in. */
  emptyAction?: ReactNode;
  /** Extra line on a pool card, such as "4 variables · 2 secrets". */
  summary?: (pool: PoolSummary) => ReactNode;
  /** Replaces the card's icon: a persona's avatar. */
  Leading?: ComponentType<{ pool: PoolSummary }>;
  /** Extra detail in a workspace's Configuration row, under its pools: statuses, warnings, next steps. */
  ConfigurationDetail?: ComponentType<{ workspace: Workspace; assignments: WorkspacePoolAssignment[] }>;
  /** Replaces the create dialog's default chips for this type in Add-ons. */
  AddOn?: ComponentType<{ pools: PoolSummary[]; value: string[]; onChange: (poolIds: string[]) => void }>;
  /** What assigning this pool means, shown in bulk assignment (Secrets & env FR10: assigning is sharing). */
  assignNote?: (pool: PoolSummary) => ReactNode;
  /** Added to the delete confirmation (Secrets & env FR20: deleting is not revoking). */
  deleteNote?: string;
  /** Delete takes the pool out of the workspaces that have it, then deletes it (Secrets & env FR19). */
  deleteUnassigns?: boolean;
  /**
   * Saves are drafts until published (Persona PRD FR14): the editor offers "Save draft" and "Publish" in
   * place of "Save", and the revisions list says Publish where other types say Approve.
   */
  drafts?: boolean;
  /** A workspace has at most one pool of this type (personas): its pickers choose one. */
  single?: boolean;
  /** What publishing reaches and when, for the confirmation (Persona PRD §11); `workspaces` is how many follow the pool. */
  publishNote?: (workspaces: number) => string;
}

/** One tab of the Pools hub (Skillset PRD §18 A8). */
export interface PoolTab {
  /** Kept in `?tab=`: accounts, skills, personas, mcp, secrets, browser. */
  id: string;
  label: string;
  /** What the tab shows. */
  element: ReactNode;
  /**
   * The type's own routes under `/admin/pools/<id>/` (library, catalog, review, page editors), with
   * paths relative to there. A type's pages are routes, not nested tabs, since nested tabs stack in a hub.
   */
  routes?: { path: string; element: ReactNode }[];
  /**
   * Set for multi-assignment pool types: the shared editor, the workspace Configuration row, the create
   * dialog's Add-ons and bulk assignment use it. (`any`: each type has its own content shape.)
   */
  pool?: MultiPoolUi<any>;
}
