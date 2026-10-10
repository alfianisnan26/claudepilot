import { DEFAULT_UI_STRINGS, type UiStrings } from '@isnanme/ui';

/** The words @isnanme/ui's primitives say themselves, in English. */
export const uiStrings: UiStrings = {
  ...DEFAULT_UI_STRINGS,
  close: 'Close',
  cancel: 'Cancel',
  save: 'Save',
  optional: 'Optional',
  code: 'Code',
  times: (n) => `${n} times`,
  discard: {
    title: 'Discard changes?',
    body: 'What you entered will be lost.',
    confirm: 'Discard',
    keep: 'Keep editing',
  },
  loading: 'Loading…',
  loadFailed: 'Could not load. Check your connection and try again.',
  retry: 'Try again',
  locale: 'en-GB',
  copy: { label: 'Copy', copied: 'Copied', toast: 'Copied', failed: 'Could not copy' },
  date: {
    pickDate: 'Pick a date',
    pickDateTime: 'Pick a date & time',
    pickMonth: 'Pick a month',
    clear: (label) => `Clear ${label}`,
    quick: (label) => `Quick picks for ${label}`,
    prevMonth: 'Previous month',
    nextMonth: 'Next month',
  },
};
