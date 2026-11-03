import {
  REPORTER_LIMITS,
  type ReporterCaptureInput,
  type ReporterCreateTicketRequest,
  type ReporterCreateTicketResponse,
} from '@portal/contracts';
import type { ReporterClient } from './api';
import { uploadPlan } from './annotate';
import type { Capture } from './context';
import { uploadCount } from './journey';

/*
 * Filing a report from the shots the panel holds: ONE path for the Report form, "Add to it" and the WebMCP tools (PILOT-1128), so an
 * agent's report goes through the same /reporter/v1 routes, token, validation, rate limits and bucket rules as the person's.
 */

/** What a shot sends as a capture of the ticket (the files follow as attachments named by captureId). */
export const captureInput = (c: Capture, note: string | null): ReporterCaptureInput => ({
  captureId: c.captureId,
  pageUrl: c.evidence.page.url,
  anchor: c.evidence.anchor,
  note,
  ...(c.annotations?.length ? { annotations: c.annotations } : {}),
});

/**
 * Uploads a capture's screenshot (the blurred image when a mark blurs, never the original then), its annotated image, and its evidence;
 * returns what failed (the ticket or comment exists either way).
 */
export async function uploadCapture(
  attach: (captureId: string, kind: 'screenshot' | 'annotated' | 'evidence', blob: Blob) => Promise<unknown>,
  c: Capture,
  onStep: () => void = () => undefined,
): Promise<string[]> {
  const failed: string[] = [];
  for (const f of uploadPlan(c)) {
    try {
      await attach(c.captureId, f.kind, f.blob);
    } catch {
      failed.push(f.kind === 'annotated' ? 'annotated image' : 'screenshot');
    }
    onStep();
  }
  const json = new Blob([JSON.stringify(c.evidence)], { type: 'application/json' });
  if (json.size > REPORTER_LIMITS.evidenceBytes) failed.push('evidence (too large)');
  else
    try {
      await attach(c.captureId, 'evidence', json);
    } catch {
      failed.push('evidence');
    }
  onStep();
  return failed;
}

/** Creates the ticket with every shot as a capture, then uploads each shot's files. `onUpload(done, total)` reports the upload steps. */
export async function fileReport(
  client: ReporterClient,
  req: Omit<ReporterCreateTicketRequest, 'captures'>,
  shots: Capture[],
  onUpload: (done: number, total: number) => void = () => undefined,
): Promise<{ res: ReporterCreateTicketResponse; failed: string[] }> {
  const res = await client.createTicket({ ...req, captures: shots.map((c) => captureInput(c, null)) });
  const failed: string[] = [];
  const total = uploadCount(shots);
  let done = 0;
  onUpload(done, total);
  for (const c of shots)
    failed.push(
      ...(await uploadCapture(
        (id, kind, blob) => client.attach(res.key, id, kind, blob),
        c,
        () => onUpload(++done, total),
      )),
    );
  return { res, failed };
}

/** Adds shots to an open ticket ("Add to it"): the captures, then each shot's files. */
export async function addShots(client: ReporterClient, key: string, shots: Capture[]): Promise<string[]> {
  await client.addCaptures(key, { captures: shots.map((c) => captureInput(c, null)) });
  const failed: string[] = [];
  for (const c of shots) failed.push(...(await uploadCapture((id, kind, blob) => client.attach(key, id, kind, blob), c)));
  return failed;
}
