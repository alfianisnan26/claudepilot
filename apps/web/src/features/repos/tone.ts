import type { Tone } from './labels';

/** The classes of a pill in each tone: the kit's Badge colours, for the controls that are buttons and so can't be a Badge. */
export const TONE_CLASS: Record<Tone, string> = {
  neutral: 'bg-surface-2 text-ink-soft',
  success: 'bg-accent-soft text-accent',
  warning: 'bg-amber-500/12 text-amber-700 dark:text-amber-400',
  danger: 'bg-danger-soft text-danger',
};

/** The same tones as text colour, for a value that is out of the ordinary (the sheet's rows). */
export const TONE_TEXT: Record<Tone, string> = {
  neutral: 'text-ink',
  success: 'text-accent',
  warning: 'text-amber-700 dark:text-amber-400',
  danger: 'text-danger',
};

/** And as the dot beside a timeline line. */
export const TONE_DOT: Record<Tone, string> = {
  neutral: 'bg-line-strong',
  success: 'bg-accent',
  warning: 'bg-amber-500',
  danger: 'bg-danger',
};
