/** Total song length from a number of seconds, such as `4:05` or `1:02:03`. */
export function formatDuration(seconds: number | null | undefined): string | null {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return null;
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const ss = String(secs).padStart(2, '0');
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${ss}`;
  return `${minutes}:${ss}`;
}

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
