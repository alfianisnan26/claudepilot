import { reasonText, type SpendFigure } from '@portal/contracts';
import type { ReactNode } from 'react';
import { InfoTip } from '@/components/InfoTip';

/** What a figure says as text: the formatted value, or "-" where it is not available. */
export function figureText<T = number>(figure: SpendFigure<T>, format: (v: T) => string): string {
  return figure.basis === 'unavailable' ? '-' : format(figure.value);
}

/**
 * The tip that goes with a figure (round 4 plan P1): "est." with the formula in one line for an estimate, an ⓘ with the reason for an
 * unavailable one, nothing for a measured one. `formula` is the one line; leave it off where a column header already carries the label.
 */
export function figureTip<T = number>(figure: SpendFigure<T>, formula?: ReactNode): ReactNode {
  if (figure.basis === 'unavailable') return <InfoTip label="Why not available">{reasonText(figure.reason)}</InfoTip>;
  if (figure.basis === 'estimate') {
    return (
      <InfoTip text="est." label="How this is estimated">
        {formula ?? 'An estimate, not a measurement.'}
      </InfoTip>
    );
  }
  return null;
}

/**
 * A derived figure with its basis: a measured one shows as it is, an estimate carries "est." (a tap opens the formula), an unavailable one
 * is "-" with the reason in a tip. A zero is only ever shown for a measured or estimated zero, never for "not known". `bare`: no tip (a
 * column header carries it).
 */
export function FigureValue<T = number>({ figure, format, formula, bare }: { figure: SpendFigure<T>; format: (v: T) => ReactNode; formula?: ReactNode; bare?: boolean }) {
  return (
    <span className="inline-flex items-center">
      {figure.basis === 'unavailable' ? <span aria-label="Not available">-</span> : format(figure.value)}
      {!bare && figureTip(figure, formula)}
    </span>
  );
}

/** The plain text of a figure for a hover note or a screen reader: "est. 41 %", "not available: Not read yet.". */
export function figureWords<T = number>(figure: SpendFigure<T>, format: (v: T) => string): string {
  if (figure.basis === 'unavailable') return `not available: ${reasonText(figure.reason)}`;
  return figure.basis === 'estimate' ? `est. ${format(figure.value)}` : format(figure.value);
}

/** What "dollars" mean, the one line every dollar figure's tip says. Claude Code prices tokens at API list prices. */
export const DOLLARS_FORMULA = 'Claude Code’s price estimate (API list prices). On a plan it is what the use would cost, not a bill.';
