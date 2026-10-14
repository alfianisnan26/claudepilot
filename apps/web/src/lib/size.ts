import { useSyncExternalStore } from 'react';

/**
 * The size classes (T-158), by the window's width in CSS px, defined once: compact is a phone, medium a tablet, expanded an HD
 * desktop, large FHD and QHD, xlarge 4K and ultrawide. The same thresholds are the `--breakpoint-*` tokens in index.css (the
 * `medium:` to `xlarge:` variants; size.test.ts keeps the two equal). A panel that must respond to its OWN width uses a container
 * query instead (every Workbench panel is a container).
 */
export const SIZE_CLASSES = ['compact', 'medium', 'expanded', 'large', 'xlarge'] as const;
export type SizeClass = (typeof SIZE_CLASSES)[number];

/** Where each class starts. */
export const SIZE_MIN: Record<SizeClass, number> = { compact: 0, medium: 600, expanded: 1024, large: 1600, xlarge: 2560 };

export function sizeClassOf(width: number): SizeClass {
  for (let i = SIZE_CLASSES.length - 1; i > 0; i--) if (width >= SIZE_MIN[SIZE_CLASSES[i]!]) return SIZE_CLASSES[i]!;
  return 'compact';
}

/** `size` is `min` or wider. */
export const atLeast = (size: SizeClass, min: SizeClass): boolean => SIZE_CLASSES.indexOf(size) >= SIZE_CLASSES.indexOf(min);

const subscribe = (change: () => void) => {
  window.addEventListener('resize', change);
  return () => window.removeEventListener('resize', change);
};

/** The window's size class; a component re-renders only when the class changes, not on every resize. */
export function useSize(): SizeClass {
  return useSyncExternalStore(subscribe, () => sizeClassOf(window.innerWidth), () => 'compact');
}
