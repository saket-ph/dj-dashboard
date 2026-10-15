export function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export const STATUS_LABEL = {
  pending: 'Pending',
  played: 'Played',
  skipped: 'Skipped',
} as const;

/** Symbols supplement (never replace) the text label so status is not conveyed by color alone. */
export const STATUS_SYMBOL = {
  pending: '●',
  played: '✓',
  skipped: '✕',
} as const;
