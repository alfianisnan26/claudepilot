import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { BYPASS_LIFETIME, BYPASS_LIFETIME_ABOUT } from './bypassCopy.js';

const src = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

test('PILOT-1008: the Bypass line says a move and a restart keep it, and that after a switch-off only a person turns it back on', () => {
  // The old text claimed the opposite of #keepBypass: that a restart or a move turns it off.
  for (const text of [BYPASS_LIFETIME, BYPASS_LIFETIME_ABOUT]) assert.doesNotMatch(text, /turns off when the agent (sleeps|restarts|moves)/i);
  assert.equal(BYPASS_LIFETIME, 'A move or a restart keeps it on; once switched off, only a person turns it back on.');
  // T-2884 review c43988: the line names no closed list of ends (a policy switch-off and a non-lead's sleep end it too).
  assert.doesNotMatch(BYPASS_LIFETIME, /until/);
  // One line (text diet): one sentence.
  assert.equal(BYPASS_LIFETIME.split(/[.!?](\s|$)/).filter((s) => s.trim()).length, 1);
});

test('PILOT-1008: the InfoTip names every way back and every end: move, Restart, recovery, a lead’s wake, Keep going, workers, the final ends', () => {
  assert.match(BYPASS_LIFETIME_ABOUT, /Deny rules still apply/);
  assert.match(BYPASS_LIFETIME_ABOUT, /A move to another Claude, a Restart or a recovery puts it back by itself while the policy allows it/);
  assert.match(BYPASS_LIFETIME_ABOUT, /A sleep or a lost process turns it off, except for a lead a person put in it: its wake puts it back/);
  assert.match(BYPASS_LIFETIME_ABOUT, /Keep going can within 24 hours/);
  assert.match(BYPASS_LIFETIME_ABOUT, /A switch-off, the policy turned off, or the chat ending is final/);
});

test('T-2884 review c43988: only a worker that got Bypass from its lead follows the lead; one a person turned on keeps it', () => {
  // #parentLeftBypass takes out only workers whose `bypass.capable` row says how `inherit`; a worker a person put in Bypass (the dialog,
  // or its own approval card) keeps it when the lead leaves.
  assert.match(BYPASS_LIFETIME_ABOUT, /A worker that got it from its lead leaves it when the lead does; one you turn on yourself keeps it\./);
  assert.doesNotMatch(BYPASS_LIFETIME_ABOUT, /Workers keep it only while their lead/);
});

test('PILOT-1008: the Bypass dialog and the Bypass approval card both show the shared line and InfoTip, and neither keeps the old claim', () => {
  for (const file of ['./BypassDialog.tsx', '../approvals/ApprovalCard.tsx']) {
    const text = src(file);
    assert.match(text, /\{BYPASS_LIFETIME\}/, `${file} shows the line`);
    assert.match(text, /\{BYPASS_LIFETIME_ABOUT\}/, `${file} shows the InfoTip`);
    assert.doesNotMatch(text, /turns off when the agent sleeps/, `${file} drops the old claim`);
  }
});
