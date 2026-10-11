import { PoolEditorPage } from './PoolEditor';
import { PoolList } from './PoolList';
import type { MultiPoolUi, PoolTab } from './types';

/**
 * A multi-assignment pool type's hub tab, ready for the registry: the shared pool list (cards, editor,
 * Duplicate, Assign, Revisions, Delete), the page editor's routes when `editor` is 'page', and the
 * type's own `routes`. The same definition feeds the workspace Configuration row, the create dialog's
 * Add-ons and bulk assignment.
 */
export function definePoolType<C>(def: { id: string; label: string; routes?: PoolTab['routes'] } & MultiPoolUi<C>): PoolTab {
  const { id, label, routes = [], ...ui } = def;
  const editorRoutes =
    ui.editor === 'page'
      ? [
          { path: 'new', element: <PoolEditorPage tabId={id} ui={ui} /> },
          { path: ':poolId/edit', element: <PoolEditorPage tabId={id} ui={ui} /> },
        ]
      : [];
  return { id, label, element: <PoolList tabId={id} label={label} ui={ui} />, routes: [...editorRoutes, ...routes], pool: ui };
}
