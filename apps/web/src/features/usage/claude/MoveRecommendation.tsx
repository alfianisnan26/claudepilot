import type { MoveRecommendation } from '@portal/contracts';
import { useEffect, useState } from 'react';
import { InfoTip } from '@/components/InfoTip';
import { usageApi } from '@/lib/usage';
import { candidateOf, moveWords, noneWords, recommendedId } from './moveWords';

/**
 * Which Claude a chat should move to, as the portal ranks them by what each has left and when it resets (docs/prd/claude-usage.md §20.5): the
 * Claudes of `workspaceId` but `fromClaudeId`. Null until it arrives, and for good if it cannot be had: the dialog then works as it always did.
 */
export function useMoveAdvice(workspaceId: string | null, fromClaudeId: string | null, enabled: boolean): MoveRecommendation | null {
  const [advice, setAdvice] = useState<MoveRecommendation | null>(null);
  useEffect(() => {
    if (!enabled || !workspaceId) {
      setAdvice(null);
      return;
    }
    let live = true;
    usageApi.recommend(workspaceId, fromClaudeId ?? undefined).then(
      (a) => live && setAdvice(a),
      () => live && setAdvice(null),
    );
    return () => void (live = false);
  }, [enabled, workspaceId, fromClaudeId]);
  return advice;
}

/** "Recommended" beside the best destination, with why in the ⓘ; nothing beside the others. */
export function RecommendedMark({ advice, claudeId }: { advice: MoveRecommendation | null; claudeId: string }) {
  const words = moveWords(candidateOf(advice, claudeId));
  if (!words) return null;
  return (
    <span className="inline-flex items-center text-[12.5px] font-medium text-accent">
      Recommended
      <InfoTip label="Why recommended">{words}</InfoTip>
    </span>
  );
}

/** One line under the destinations when every Claude that could take the chat is nearly out (the dialog says the other cases itself). */
export function NoRecommendation({ advice }: { advice: MoveRecommendation | null }) {
  const words = advice && noneWords(advice.none);
  return words ? <p className="text-[13px] text-muted">{words}</p> : null;
}

export { recommendedId };
