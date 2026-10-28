import type { Approval } from '@portal/contracts';
import { EmptyState, LoadError, RowsSkeleton } from '@isnanme/ui';
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { PageHeader } from '@/components/PageHeader';
import { ApiError } from '@/lib/api';
import { approvalsApi } from './api';
import { ApprovalCard } from './ApprovalCard';

/** `/admin/approvals/:id`: one request an agent made, opened from Needs you or its notification (docs/prd/approvals.md). */
export function ApprovalPage() {
  const { id = '' } = useParams();
  const [approval, setApproval] = useState<Approval | null>(null);
  const [state, setState] = useState<'loading' | 'ok' | 'missing' | 'failed'>('loading');

  const load = useCallback(async () => {
    setState('loading');
    try {
      setApproval(await approvalsApi.get(id));
      setState('ok');
    } catch (e) {
      setState(e instanceof ApiError && e.status === 404 ? 'missing' : 'failed');
    }
  }, [id]);

  useEffect(() => void load(), [load]);

  return (
    <div className="mx-auto flex w-full max-w-2xl min-w-0 flex-col gap-4">
      <PageHeader title="Approval" />
      {state === 'loading' && <RowsSkeleton rows={1} lines={4} card label="Loading the request" />}
      {state === 'failed' && <LoadError onRetry={() => void load()} message="Could not read the request." />}
      {state === 'missing' && <EmptyState title="No such request" />}
      {state === 'ok' && approval && <ApprovalCard approval={approval} onChange={setApproval} />}
    </div>
  );
}
