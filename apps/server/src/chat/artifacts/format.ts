/** "850 B", "12 KB", "3.4 MB" (decimal units, like the limits). */
export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 999_500) return `${bytes < 9_950 ? (bytes / 1000).toFixed(1) : Math.round(bytes / 1000)} KB`;
  return `${(bytes / 1_000_000).toFixed(bytes < 9_950_000 ? 1 : 0)} MB`;
}
