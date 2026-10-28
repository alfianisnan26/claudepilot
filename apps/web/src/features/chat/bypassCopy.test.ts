import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { BYPASS_LIFETIME, BYPASS_LIFETIME_ABOUT } from './bypassCopy.js';

const src = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

test('PILOT-1008: the Bypass copy says it is kept through a move and a restart, and ends only on a switch-off or the chat ending', () => {
  // The old text claimed the opposite of #keepBypass: that a restart or a move turns it off.
  for (const text of [BYPASS_LIFETIME, BYPASS_LIFETIME_ABOUT]) assert.doesNotMatch(text, /turns off when the agent (sleeps|restarts|moves)/i);
  assert.match(BYPASS_LIFETIME, /stays on through a move or a restart/);
  assert.match(BYPASS_LIFETIME, /until you switch it off or the chat ends/);
  // One line (text diet): one sentence.
  assert.equal(BYPASS_LIFETIME.split(/[.!?](\s|$)/).filter((s) => s.trim()).length, 1);
});

test('PILOT-1008: the InfoTip names every way back and every end: move, Restart, recovery, a lead’s wake, Keep going, workers, a person’s switch-off', () => {
  assert.match(BYPASS_LIFETIME_ABOUT, /Deny rules still apply/);
  assert.match(BYPASS_LIFETIME_ABOUT, /after a move to another Claude, a Restart or a recovery, while the policy allows it/);
  assert.match(BYPASS_LIFETIME_ABOUT, /A sleep turns it off, except for a lead: its wake puts it back/);
  assert.match(BYPASS_LIFETIME_ABOUT, /Keep going can within 24 hours/);
  assert.match(BYPASS_LIFETIME_ABOUT, /Workers keep it only while their lead is in it/);
  assert.match(BYPASS_LIFETIME_ABOUT, /switches it off or ends the chat, it is gone for good/);
});

test('PILOT-1008: the Bypass dialog and the Bypass approval card both show the shared line and InfoTip, and neither keeps the old claim', () => {
  for (const file of ['./BypassDialog.tsx', '../approvals/ApprovalCard.tsx']) {
    const text = src(file);
    assert.match(text, /\{BYPASS_LIFETIME\}/, `${file} shows the line`);
    assert.match(text, /\{BYPASS_LIFETIME_ABOUT\}/, `${file} shows the InfoTip`);
    assert.doesNotMatch(text, /turns off when the agent sleeps/, `${file} drops the old claim`);
  }
});
