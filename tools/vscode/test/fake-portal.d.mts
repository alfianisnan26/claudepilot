export interface FakePortal {
  url: string;
  state: {
    token: string | null;
    api: number;
    calls: { method: string; path: string; auth: string | null; cookie: boolean }[];
    sent: { id: string; text: string }[];
    answered: Record<string, unknown>[];
    pending: Map<string, { approved: boolean; polls: number; client: string }>;
  };
  close(): Promise<void>;
}
export function startFakePortal(opts?: { api?: number; minApi?: number; interval?: number; autoApproveAfter?: number; port?: number }): Promise<FakePortal>;
export function fakeData(): Record<string, unknown[]>;
