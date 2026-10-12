// What other pages use of Claude usage (PRD claude-usage §13): a tiny meter for a Claude's row, and the headroom line for the
// switch dialog. Both read the shared snapshot, so they ask the portal for nothing of their own.
export { ClaudeMeter } from './Meter';
export { ClaudeHeadroom, useHeadroom } from './Headroom';
export { headroomLine } from './format';
