import type { SongRequestRepository } from './db/requestRepository.js';
import type { Logger } from './logger.js';
import type { SongRequest } from './types.js';

/** A YouTube video id is 11 characters from this set. Anything else is rejected. */
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

export interface YoutubeMatch {
  videoId: string;
  title: string | null;
  /** Total length in seconds, or null when YouTube did not return one. */
  durationSeconds: number | null;
}

export interface YoutubeClient {
  /** Returns the first video, null when YouTube has no match, or throws on a transport/API failure. */
  search(query: string): Promise<YoutubeMatch | null>;
  /** Lengths for videos already stored. Missing ids are omitted. Never throws. */
  durations?(videoIds: readonly string[]): Promise<Map<string, number>>;
}

/** YouTube's `PT#H#M#S` length, in seconds. */
export function parseIsoDuration(value: string): number | null {
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(value.trim());
  if (!match || value.trim() === 'PT') return null;
  const total = Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
  return total > 0 ? total : null;
}

export class YoutubeLookupError extends Error {
  constructor(readonly status: number) {
    super('YouTube lookup failed');
    this.name = 'YoutubeLookupError';
  }
}

/** Search text: the song title, plus the artist when the audience provided one. */
export function songSearchQuery(songTitle: string, artistName: string | null): string {
  const title = songTitle.trim();
  const artist = artistName?.trim();
  return artist ? `${title} ${artist}` : title;
}

/** Watch URL built only from a validated video id, so it cannot point anywhere else. */
export function youtubeWatchUrl(videoId: string): string | null {
  return VIDEO_ID.test(videoId) ? `https://www.youtube.com/watch?v=${videoId}` : null;
}

/**
 * One YouTube Data API search. The key is a query parameter and must never be logged.
 * `search.list` costs 100 quota units; callers search once per new request and store the result.
 */
async function readDurations(
  apiKey: string,
  videoIds: readonly string[],
  fetchImpl: typeof fetch,
): Promise<Map<string, number>> {
  const ids = [...new Set(videoIds.filter((id) => VIDEO_ID.test(id)))].slice(0, 50);
  const found = new Map<string, number>();
  if (ids.length === 0) return found;
  const url = new URL('https://www.googleapis.com/youtube/v3/videos');
  url.searchParams.set('part', 'contentDetails');
  url.searchParams.set('id', ids.join(','));
  url.searchParams.set('key', apiKey);
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new YoutubeLookupError(response.status);
  const body = (await response.json()) as {
    items?: { id?: unknown; contentDetails?: { duration?: unknown } }[];
  };
  for (const item of body.items ?? []) {
    if (typeof item.id !== 'string' || typeof item.contentDetails?.duration !== 'string') continue;
    const seconds = parseIsoDuration(item.contentDetails.duration);
    if (seconds) found.set(item.id, seconds);
  }
  return found;
}

export function createYoutubeClient(apiKey: string, fetchImpl: typeof fetch = fetch): YoutubeClient {
  return {
    async durations(videoIds: readonly string[]): Promise<Map<string, number>> {
      try {
        return await readDurations(apiKey, videoIds, fetchImpl);
      } catch {
        return new Map();
      }
    },
    async search(query: string): Promise<YoutubeMatch | null> {
      const url = new URL('https://www.googleapis.com/youtube/v3/search');
      url.searchParams.set('part', 'snippet');
      url.searchParams.set('type', 'video');
      url.searchParams.set('maxResults', '1');
      url.searchParams.set('q', query);
      url.searchParams.set('key', apiKey);

      const response = await fetchImpl(url, { signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw new YoutubeLookupError(response.status);

      const body = (await response.json()) as {
        items?: { id?: { videoId?: unknown }; snippet?: { title?: unknown } }[];
      };
      const item = body.items?.[0];
      const videoId = item?.id?.videoId;
      if (typeof videoId !== 'string' || !VIDEO_ID.test(videoId)) return null;
      const rawTitle = typeof item?.snippet?.title === 'string' ? item.snippet.title : '';
      const title = rawTitle.replace(/\s+/g, ' ').trim().slice(0, 200);
      let durationSeconds: number | null = null;
      try {
        durationSeconds = (await readDurations(apiKey, [videoId], fetchImpl)).get(videoId) ?? null;
      } catch {
        durationSeconds = null;
      }
      return { videoId, title: title || null, durationSeconds };
    },
  };
}

/**
 * Looks up a video for a committed request and stores it. Never throws: a YouTube failure
 * must not affect the request that was already saved.
 */
export async function attachYoutubeMatch(args: {
  request: SongRequest;
  client: YoutubeClient;
  repo: SongRequestRepository;
  logger: Logger;
  onUpdated?: (request: SongRequest) => void;
}): Promise<void> {
  const { request, client, repo, logger, onUpdated } = args;
  try {
    const match = await client.search(songSearchQuery(request.songTitle, request.artistName));
    if (!match) {
      logger.info('youtube lookup had no match', { requestId: request.id });
      return;
    }
    const updated = repo.setYoutube(request.id, match.videoId, match.title, match.durationSeconds ?? null);
    if (updated) onUpdated?.(updated);
  } catch (err) {
    const status = err instanceof YoutubeLookupError ? err.status : undefined;
    logger.warn('youtube lookup failed', status === undefined ? { requestId: request.id } : { requestId: request.id, status });
  }
}

/** Fills in lengths for songs that already have a video id. Never throws. */
export async function fillSongDurations(args: {
  client: YoutubeClient;
  repo: SongRequestRepository;
  logger: Logger;
  onUpdated?: (request: SongRequest) => void;
}): Promise<void> {
  if (!args.client.durations) return;
  const missing = args.repo.missingDurations();
  if (missing.length === 0) return;
  try {
    const lengths = await args.client.durations(missing.map((row) => row.videoId));
    for (const row of missing) {
      const seconds = lengths.get(row.videoId);
      if (!seconds) continue;
      const updated = args.repo.setDuration(row.id, seconds);
      if (updated) args.onUpdated?.(updated);
    }
  } catch (err) {
    const status = err instanceof YoutubeLookupError ? err.status : undefined;
    args.logger.warn('youtube duration lookup failed', status === undefined ? {} : { status });
  }
}
