import { AccountsPage } from '@/features/accounts/AccountsPage';
import { secretsTab } from '@/features/secrets/tab';
import type { PoolTab } from './types';

/**
 * The Pools hub's tabs, in order (Skillset PRD §18 A8: accounts, skills, personas, mcp, secrets,
 * browser). A multi-assignment pool type registers with one line here, `definePoolType({ … })` from
 * its own feature folder, which also gives it a workspace Configuration row, Add-ons in the create
 * dialog and a place in bulk assignment.
 */
export const POOL_TABS: PoolTab[] = [{ id: 'accounts', label: 'Accounts', element: <AccountsPage /> }, secretsTab];

export type MultiPoolTab = PoolTab & { pool: NonNullable<PoolTab['pool']> };

/** Registered multi-assignment pool types, with their tabs, in tab order. */
export const multiPoolTabs = (): MultiPoolTab[] => POOL_TABS.filter((t): t is MultiPoolTab => !!t.pool);
