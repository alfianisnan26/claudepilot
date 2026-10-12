import type { SkillsetContentView } from '@portal/contracts';
import { Sparkles } from 'lucide-react';
import { definePoolType } from '@/features/pools/definePoolType';
import { LibraryLink } from './LibraryLink';
import { LibraryPage } from './LibraryPage';
import { ReviewPage } from './ReviewPage';
import { SkillsConfiguration } from './SkillsConfiguration';
import { SkillsetEditor } from './SkillsetEditor';
import { setSummary } from './labels';

/**
 * Skillsets' tab in the Pools hub (Skillset PRD §13, `/admin/pools?tab=skills`): the sets, with the Library
 * and each skill's review as routes of their own (`/admin/pools/skills/library`, `…/review/:versionId`),
 * the set editor page, and the workspace Configuration row.
 */
export const skillsTab = definePoolType<SkillsetContentView>({
  id: 'skills',
  label: 'Skills',
  type: 'skillset',
  noun: { one: 'skillset', other: 'skillsets' },
  description: 'Reviewed skills, grouped into sets, that workspaces get as commands. Every skill is approved before it is delivered.',
  icon: Sparkles,
  emptyContent: () => ({ prefix: '', skills: [] }),
  Editor: SkillsetEditor,
  // A row per skill: a page of its own, full screen on phones (Web app §9.2).
  editor: 'page',
  headerAction: <LibraryLink />,
  summary: setSummary,
  ConfigurationDetail: SkillsConfiguration,
  assignNote: (pool) => {
    const scripted = ((pool.content as SkillsetContentView | null)?.skills ?? []).filter((s) => s.mode !== 'off' && s.scripted).length;
    return scripted
      ? `${scripted} of its skills run scripts or shell commands. Assigning it runs that code, with the user’s rights, in every workspace it reaches.`
      : 'Skills run with the workspace user’s rights. Assigning a skillset adds its commands to every workspace it reaches.';
  },
  routes: [
    { path: 'library', element: <LibraryPage /> },
    { path: 'review/:versionId', element: <ReviewPage /> },
  ],
});
