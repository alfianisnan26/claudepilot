import { buttonClass } from '@isnanme/ui';
import { BookOpen } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useLive } from '@/lib/live';
import { skillsApi } from './api';

/** "Library · 3 to review" beside "New skillset" in the Skills tab (Skillset PRD §13). */
export function LibraryLink() {
  const [toReview, setToReview] = useState(0);
  const load = () => void skillsApi.library().then((l) => setToReview(l.toReview), () => undefined);
  useEffect(load, []);
  useLive('pools', load);
  return (
    <Link to="/admin/pools/skills/library" className={buttonClass('secondary')} aria-label={toReview ? `Library, ${toReview} to review` : 'Library'}>
      <BookOpen className="size-4" />
      <span className="hidden sm:inline">Library</span>
      {toReview > 0 && <span className="rounded-full bg-amber-500/15 px-1.5 text-[11.5px] font-semibold text-amber-700 dark:text-amber-400">{toReview}</span>}
    </Link>
  );
}
