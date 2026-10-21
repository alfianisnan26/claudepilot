import { isApiErrorBody, isApiSuccess } from '@isnanme/core';
import { track } from '@isnanme/ui';
import { FLOW_API, type FlowSnapshot } from '@portal/contracts';
import { ApiError } from '@/lib/api';
import { createLiveStore } from '../shared/liveStore';

/** GET with the session cookie, the envelope unwrapped. The route answers anyone but the owner with 404: shown as "not available". */
async function loadFlow(): Promise<FlowSnapshot> {
  let res: Response;
  try {
    res = await track(fetch(FLOW_API.snapshot, { credentials: 'same-origin' }));
  } catch {
    throw new ApiError('NETWORK_ERROR', 'Could not reach the server.', 0);
  }
  const json: unknown = await res.json().catch(() => null);
  if (res.ok && isApiSuccess<FlowSnapshot>(json)) return json.data;
  if (res.status === 404) throw new ApiError('FORBIDDEN', 'Not available.', 403);
  if (isApiErrorBody(json)) throw new ApiError(json.error.code, json.error.message, res.status, json.error.details);
  throw new ApiError('INTERNAL_ERROR', `Unexpected response (${res.status}).`, res.status);
}

/**
 * The flow watchdog's last round (T-1966); loaded again after each round (it publishes Keep going's topic, the same watchdog family), on a
 * ticket push, and when the socket comes back.
 */
export const flowStore = createLiveStore({ load: loadFlow, topics: ['keepgoing', 'tickets'] });
