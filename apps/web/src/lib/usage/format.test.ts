import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatChange, formatCost, formatPercent, formatCostRate, formatShare, formatTokenRate, formatTokens, prettyModel } from './format.js';

test('formatCost: three decimals under 10 cents, two under a dollar, trimmed above, whole above 100', () => {
  assert.equal(formatCost(0), '$0');
  assert.equal(formatCost(0.084), '$0.084');
  assert.equal(formatCost(0.5), '$0.50');
  assert.equal(formatCost(1.23), '$1.23');
  assert.equal(formatCost(12.3), '$12.3');
  assert.equal(formatCost(20), '$20');
  assert.equal(formatCost(150.4), '$150');
  assert.equal(formatCost(1234), '$1.2k');
  // Huge amounts keep a short width, and a unit steps up before it would read "1000k".
  assert.equal(formatCost(12_345), '$12k');
  assert.equal(formatCost(999_400), '$999k');
  assert.equal(formatCost(999_600), '$1.0M');
  assert.equal(formatCost(1_234_567.89), '$1.2M');
  assert.equal(formatCost(4_500_000_000), '$4.5B');
});

test('formatTokens: whole below 1000, k with one decimal under 10k, M above 999.5k', () => {
  assert.equal(formatTokens(850), '850');
  assert.equal(formatTokens(1500), '1.5k');
  assert.equal(formatTokens(12_345), '12k');
  assert.equal(formatTokens(1_234_567), '1.2M');
  assert.equal(formatTokens(999_400), '999k');
  assert.equal(formatTokens(999_600), '1.0M');
  assert.equal(formatTokens(4_500_000_000), '4.5B');
  assert.equal(formatTokens(9_900_000_000_000), '9.9T');
  assert.equal(formatTokens(250_000_000_000_000), '250T');
});

test('rates read per minute', () => {
  assert.equal(formatCostRate(0.42), '$0.42/min');
  assert.equal(formatCostRate(0), '$0/min');
  assert.equal(formatTokenRate(34_960.4), '35k tok/min');
  assert.equal(formatTokenRate(0), '0 tok/min');
});

test('formatChange rounds, signs, and says 0 for a change that rounds away', () => {
  assert.equal(formatChange(12.4), '+12 %');
  assert.equal(formatChange(-8.6), '-9 %');
  assert.equal(formatChange(0.3), '0 %');
  assert.equal(formatChange(-0.4), '0 %');
  assert.equal(formatChange(250), '+250 %');
  // A huge change stays short.
  assert.equal(formatChange(1234), '+1.2k %');
  assert.equal(formatChange(-45_000), '-45k %');
  assert.equal(formatChange(123_457_391), '+123M %');
});

test('formatShare is a rounded percent of a fraction', () => {
  assert.equal(formatShare(0.724), '72 %');
  assert.equal(formatShare(1), '100 %');
  assert.equal(formatShare(0), '0 %');
});

test('prettyModel reads Opus 4.5 from the id and leaves unknown ids alone', () => {
  assert.equal(prettyModel('claude-opus-4-5'), 'Opus 4.5');
  assert.equal(prettyModel('claude-sonnet-5'), 'Sonnet 5');
  assert.equal(prettyModel('claude-haiku-4-5-20251001'), 'Haiku 4.5');
  assert.equal(prettyModel('gpt-x'), 'gpt-x');
});

test('formatPercent is a rounded percent that stays short when it is huge', () => {
  assert.equal(formatPercent(96.2), '96 %');
  assert.equal(formatPercent(117.5), '118 %');
  assert.equal(formatPercent(0), '0 %');
  assert.equal(formatPercent(61_728_548), '62M %');
  assert.equal(formatPercent(1234), '1.2k %');
});
