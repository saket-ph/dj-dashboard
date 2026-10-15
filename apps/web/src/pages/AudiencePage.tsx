import { useEffect, useRef, useState, type FormEvent } from 'react';
import { apiFetch } from '../lib/api';
import { createAttemptKeys } from '../lib/attemptKey';
import { describeSubmitError } from '../lib/messages';
import { createSubmitLock } from '../lib/submitLock';

const LIMITS = { name: 80, song: 160, artist: 160 } as const;

type Phase = 'idle' | 'submitting' | 'success' | 'error';

interface CreatedResponse {
  request: { sequenceNumber: number };
}

export function AudiencePage() {
  const [eventTitle, setEventTitle] = useState<string | null>(null);
  const [configFailed, setConfigFailed] = useState(false);
  const [requesterName, setRequesterName] = useState('');
  const [songTitle, setSongTitle] = useState('');
  const [artistName, setArtistName] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [message, setMessage] = useState('');
  const lock = useRef(createSubmitLock());
  const attemptKeys = useRef(createAttemptKeys());

  async function loadConfig() {
    setConfigFailed(false);
    try {
      const { data } = await apiFetch<{ eventTitle: string }>('/api/config');
      setEventTitle(data.eventTitle);
    } catch {
      setConfigFailed(true);
    }
  }

  useEffect(() => {
    void loadConfig();
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
      const idempotencyKey = attemptKeys.current.keyFor({ requesterName, songTitle, artistName });
      const payload: Record<string, string> = { requesterName, songTitle, idempotencyKey };
      if (artistName.trim() !== '') payload.artistName = artistName;
      await apiFetch<CreatedResponse>('/api/requests', { method: 'POST', body: JSON.stringify(payload) });
      // Success is shown only after the server confirmed the committed 201 (or a 200 replay).
      attemptKeys.current.succeeded();
      setPhase('success');
      setMessage('Your request is in the queue. Thanks!');
      setRequesterName('');
      setSongTitle('');
      setArtistName('');
    } catch (err) {
      // Keep the typed values so the user can correct or retry.
      setPhase('error');
      setMessage(describeSubmitError(err));
    } finally {
      lock.current.release();
    }
  }

  const submitting = phase === 'submitting';

  return (
    <main className="page">
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

        <div className="field">
          <label htmlFor="artistName">
            Artist <span className="optional">(optional)</span>
          </label>
          <input
            id="artistName"
            name="artistName"
            type="text"
            autoComplete="off"
            maxLength={LIMITS.artist}
            value={artistName}
            onChange={(e) => setArtistName(e.target.value)}
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
      </form>
    </main>
  );
}
