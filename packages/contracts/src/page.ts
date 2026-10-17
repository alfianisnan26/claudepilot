/** Paging (D-58): every list route answers one page of this shape. `next` is an opaque cursor for the following page, null on the last. */
export interface CursorPage<T> {
  items: T[];
  next: string | null;
}

/** The query every cursor-paged list route takes. */
export interface CursorQuery {
  cursor?: string;
  /** Rows per page: 25 when absent, at most 100 (the server clamps). */
  limit?: number;
}

export const CURSOR_DEFAULT_LIMIT = 25;
export const CURSOR_MAX_LIMIT = 100;
