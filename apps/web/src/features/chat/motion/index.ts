/**
 * Motion for the chat session: the live reply revealed word by word, the transcript following it smoothly, and
 * the hand-over from the live reply to the stored one. The tokens (tokens.ts) are the one place durations and
 * curves live. See StreamingMarkdown.tsx for how the reply is paced and rendered.
 */
export { StreamingMarkdown } from './StreamingMarkdown';
export { MOTION } from './tokens';
export { useFollow, type Follow } from './useFollow';
export { useHandover, type Handover, type LiveReply } from './useHandover';
