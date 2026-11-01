import { PORTAL_USER_API, type MyWebSession, type SignedInAs, type UpdateMyProfileRequest } from '@portal/contracts';
import { poolRequest } from '@/features/pools/request';

/** The person's own profile routes (owner request 2026-11-01). Each acts on the signed-in account only; none takes an account id. */
export const profileApi = {
  update: (req: UpdateMyProfileRequest) => poolRequest<SignedInAs>('PATCH', PORTAL_USER_API.me, req),
  setAvatar: (file: Blob) => poolRequest<{ avatar: string }>('POST', PORTAL_USER_API.myAvatar, undefined, { body: file, headers: { 'Content-Type': file.type || 'application/octet-stream' } }),
  clearAvatar: () => poolRequest<{ avatar: null }>('DELETE', PORTAL_USER_API.myAvatar),
  devices: () => poolRequest<MyWebSession[]>('GET', PORTAL_USER_API.myDevices),
  endDevice: (id: string) => poolRequest<{ removed: true }>('DELETE', PORTAL_USER_API.myDevice(id)),
};
