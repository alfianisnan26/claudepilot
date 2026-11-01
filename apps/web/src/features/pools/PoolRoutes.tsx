import { Navigate, Route, Routes, useParams } from 'react-router';
import { HOME } from '@/app/nav';
import { POOL_TABS } from './registry';

/**
 * A pool type's own pages (`/admin/pools/<type>/<path>`: library, catalog, review, page editors), as declared by its tab in the registry.
 * Its own chunk with the registry (owner request 2026-11-01, performance), so the first load of the app does not carry every pool type.
 * A path no pool type declares goes Home, as the app's catch-all did.
 */
export function PoolRoutes() {
  const { type } = useParams();
  const tab = POOL_TABS.find((t) => t.id === type);
  return (
    <Routes>
      {(tab?.routes ?? []).map((r) => (
        <Route key={r.path} path={r.path} element={r.element} />
      ))}
      <Route path="*" element={<Navigate to={HOME} replace />} />
    </Routes>
  );
}
