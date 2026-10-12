/** The tree while it loads: rows the size of the real ones (56 px: a name over a branch, a chip at the right), so nothing jumps when they land. */
export function TreeSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <ul aria-busy="true" aria-label="Loading" className="flex flex-col">
      {Array.from({ length: rows }, (_, i) => (
        <li key={i} className="flex h-14 items-center gap-3 px-2">
          <span className="flex min-w-0 flex-1 flex-col gap-1.5">
            <span className={`skeleton h-3.5 rounded-full ${i % 3 === 1 ? 'w-24' : 'w-32'}`} />
            <span className="skeleton h-3 w-12 rounded-full" />
          </span>
          {i % 2 === 0 && <span className="skeleton h-5 w-16 shrink-0 rounded-full" />}
        </li>
      ))}
    </ul>
  );
}

/** A timeline while it loads. */
export function LinesSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <ul aria-busy="true" aria-label="Loading" className="flex flex-col gap-3">
      {Array.from({ length: rows }, (_, i) => (
        <li key={i} className="flex items-start gap-2.5">
          <span className="skeleton mt-1.5 size-2 shrink-0 rounded-full" />
          <span className="flex min-w-0 flex-1 flex-col gap-1.5">
            <span className="skeleton h-3.5 w-4/5 rounded-full" />
            <span className="skeleton h-3 w-1/3 rounded-full" />
          </span>
        </li>
      ))}
    </ul>
  );
}
