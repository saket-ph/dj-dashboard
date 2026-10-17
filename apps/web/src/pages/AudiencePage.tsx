import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, apiFetch } from '../lib/api';
import { createAttemptKeys } from '../lib/attemptKey';
import { describeSubmitError } from '../lib/messages';
import { createSubmitLock } from '../lib/submitLock';

const LIMITS = { name: 80, song: 160 } as const;

type Phase = 'idle' | 'submitting' | 'success' | 'error';

interface CreatedResponse {
  request: { sequenceNumber: number };
}

interface PopularSong {
  id: string;
  songTitle: string;
  count: number;
  liked?: boolean;
}

interface CheerResponse {
  liked: boolean;
  songTitle: string;
}

export function AudiencePage() {
  const [eventTitle, setEventTitle] = useState<string | null>(null);
  const [configFailed, setConfigFailed] = useState(false);
  const [requesterName, setRequesterName] = useState('');
  const [songTitle, setSongTitle] = useState('');
  const [songs, setSongs] = useState<PopularSong[]>([]);
  const [phase, setPhase] = useState<Phase>('idle');
  const [message, setMessage] = useState('');
  const lock = useRef(createSubmitLock());
  const attemptKeys = useRef(createAttemptKeys());
  const songsRequest = useRef(0);

  async function loadConfig() {
    setConfigFailed(false);
    try {
      const { data } = await apiFetch<{ eventTitle: string }>('/api/config');
      setEventTitle(data.eventTitle);
    } catch {
      setConfigFailed(true);
    }
  }

  async function loadSongs() {
    const requestId = ++songsRequest.current;
    try {
      const { data } = await apiFetch<{ songs?: PopularSong[] }>('/api/songs');
      if (requestId !== songsRequest.current) return;
      setSongs(Array.isArray(data.songs) ? data.songs : []);
    } catch {
      // The form still works if the list cannot be loaded.
    }
  }

  useEffect(() => {
    document.body.classList.add('theme-audience');
    void loadConfig();
    void loadSongs();
    const timer = window.setInterval(() => void loadSongs(), 8000);
    return () => {
      document.body.classList.remove('theme-audience');
      window.clearInterval(timer);
    };
  }, []);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    // Guard against double submission even before the button re-renders as disabled.
    if (!lock.current.tryAcquire()) return;
    setPhase('submitting');
    setMessage('');
    try {
      // The same key is reused if this exact content is retried after a lost response, so the
      // server can return the original request instead of creating a duplicate.
      const idempotencyKey = attemptKeys.current.keyFor({ requesterName, songTitle, artistName: '' });
      await apiFetch<CreatedResponse>('/api/requests', {
        method: 'POST',
        body: JSON.stringify({ requesterName, songTitle, idempotencyKey }),
      });
      // Success is shown only after the server confirmed the committed 201 (or a 200 replay).
      attemptKeys.current.succeeded();
      setPhase('success');
      setMessage('Your request is in the queue. Thanks!');
      setRequesterName('');
      setSongTitle('');
      void loadSongs();
    } catch (err) {
      // Keep the typed values so the user can correct or retry.
      setPhase('error');
      setMessage(describeSubmitError(err));
    } finally {
      lock.current.release();
    }
  }

  async function cheer(song: PopularSong, move = false) {
    if (!lock.current.tryAcquire()) return;
    setPhase('submitting');
    setMessage('');
    try {
      const { data } = await apiFetch<CheerResponse>(`/api/songs/${song.id}/like`, {
        method: 'POST',
        body: JSON.stringify({ move }),
      });
      setPhase('success');
      setMessage(
        data.liked
          ? `You're cheering for ${data.songTitle}. Tap + again on that song to take it back.`
          : `Your cheer for ${data.songTitle} was removed.`,
      );
      void loadSongs();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && !move) {
        lock.current.release();
        if (window.confirm(err.message)) {
          await cheer(song, true);
        } else {
          setPhase('idle');
        }
        return;
      }
      setPhase('error');
      setMessage(describeSubmitError(err));
    } finally {
      lock.current.release();
    }
  }

  const submitting = phase === 'submitting';

  return (
    <main className="page page--audience">
      <header className="page__header">
        <h1>{eventTitle ?? 'Song requests'}</h1>
        <p className="lede">Request a song for the DJ. No sign-up needed.</p>
        {configFailed && (
          <p className="notice" role="status">
            Could not load the event details.{' '}
            <button type="button" className="link-button" onClick={() => void loadConfig()}>
              Retry
            </button>
          </p>
        )}
      </header>

      <form className="card form" onSubmit={onSubmit} noValidate={false}>
        <div className="field">
          <label htmlFor="requesterName">Your name</label>
          <input
            id="requesterName"
            name="requesterName"
            type="text"
            autoComplete="given-name"
            required
            maxLength={LIMITS.name}
            value={requesterName}
            onChange={(e) => setRequesterName(e.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="songTitle">Song title</label>
          <input
            id="songTitle"
            name="songTitle"
            type="text"
            autoComplete="off"
            required
            maxLength={LIMITS.song}
            value={songTitle}
            onChange={(e) => setSongTitle(e.target.value)}
          />
        </div>

        <button type="submit" className="button button--primary" disabled={submitting} aria-busy={submitting}>
          {submitting ? 'Sending…' : 'Send request'}
        </button>

        <div className="feedback" aria-live="polite">
          {phase === 'success' && <p className="message message--success">{message}</p>}
          {phase === 'error' && (
            <p className="message message--error" role="alert">
              {message}
            </p>
          )}
        </div>

        <section className="song-board" aria-labelledby="songs-heading">
          <h2 id="songs-heading">Requested songs</h2>
          <p className="song-board__hint">
            Most liked first. Tap + to cheer for one song. Tap it again to take that cheer back.
          </p>
          {songs.length === 0 ? (
            <p className="song-board__empty">No songs yet. Be the first to request one.</p>
          ) : (
            <ul className="song-list">
              {songs.map((song) => (
                <li key={song.id} className="song-row">
                  <div className="song-row__main">
                    <p className="song-row__title">{song.songTitle}</p>
                    <p className="song-row__count">{song.count === 1 ? '1 like' : `${song.count} likes`}</p>
                  </div>
                  <button
                    type="button"
                    className={song.liked ? 'song-row__add song-row__add--liked' : 'song-row__add'}
                    disabled={submitting}
                    aria-pressed={song.liked === true}
                    aria-label={song.liked ? `Remove your like from ${song.songTitle}` : `Like ${song.songTitle}`}
                    onClick={() => void cheer(song)}
                  >
                    {song.liked ? '✓' : '+'}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </form>
    </main>
  );
}
