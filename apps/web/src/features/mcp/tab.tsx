import type { McpSetContent } from '@portal/contracts';
import { buttonClass } from '@isnanme/ui';
import { BookOpen, Blocks, PackagePlus } from 'lucide-react';
import { Link } from 'react-router';
import { definePoolType } from '@/features/pools/definePoolType';
import { CatalogPage } from './CatalogPage';
import { EntryPage } from './EntryPage';
import { McpAddOn } from './McpAddOn';
import { McpConfiguration } from './McpConfiguration';
import { SetEditor } from './SetEditor';
import { setSummary } from './summary';

/** The built-in shelf is at the top of the catalog page: a shortcut there, in the header and in the empty state (built-in catalogue PRD FR16). */
const builtinLink = (
  <Link to="/admin/pools/mcp/catalog" className={buttonClass('secondary')}>
    <PackagePlus className="size-4" />
    Built-in
  </Link>
);

/**
 * MCP sets' tab in the Pools hub (MCP set PRD §15, `/admin/pools?tab=mcp`): the sets, with the Catalog
 * and its entries as routes of their own (`/admin/pools/mcp/catalog…`), the set editor page, the
 * workspace Configuration row and Add-ons.
 */
export const mcpTab = definePoolType<McpSetContent>({
  id: 'mcp',
  label: 'MCP sets',
  type: 'mcpset',
  noun: { one: 'MCP set', other: 'MCP sets' },
  description: 'Reviewed MCP servers, grouped into sets, that workspaces get as tools. Secrets come from Secrets sets by name.',
  icon: Blocks,
  emptyContent: () => ({ slug: '', servers: [] }),
  Editor: SetEditor,
  // A row per server with its slots: a page of its own, full screen on phones (Web app §9.2).
  editor: 'page',
  // Built-in sits beside Catalog once there are sets, and in the empty state's own row before that (one of them, never both).
  headerAction: ({ hasPools }) => (
    <>
      <Link to="/admin/pools/mcp/catalog" className={buttonClass('secondary')} aria-label="Catalog">
        <BookOpen className="size-4" />
        <span className="hidden sm:inline">Catalog</span>
      </Link>
      {hasPools && builtinLink}
    </>
  ),
  emptyAction: builtinLink,
  summary: setSummary,
  ConfigurationDetail: McpConfiguration,
  AddOn: McpAddOn,
  routes: [
    { path: 'catalog', element: <CatalogPage /> },
    { path: 'catalog/:entryId', element: <EntryPage /> },
  ],
});
