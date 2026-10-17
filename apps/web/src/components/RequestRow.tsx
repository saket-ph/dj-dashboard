import { formatTime, STATUS_LABEL, STATUS_SYMBOL } from '../lib/format';
import type { SongRequest } from '../lib/types';

/** YouTube video ids are 11 characters. Anything else is not turned into a link. */
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

function watchUrl(videoId: string | null | undefined): string | null {
  return videoId && VIDEO_ID.test(videoId) ? `https://www.youtube.com/watch?v=${videoId}` : null;
}

interface Props {
  request: SongRequest;
  isNext?: boolean;
  busy?: boolean;
  selected?: boolean;
  onSelect?: (id: string, selected: boolean) => void;
  onMark?: (id: string, status: 'played' | 'skipped') => void;
}

/** One queue row. All user text is rendered as React text nodes, never as HTML (FR-058). */
export function RequestRow({ request, isNext = false, busy = false, selected = false, onSelect, onMark }: Props) {
  const label = STATUS_LABEL[request.status];
  const youtubeHref = watchUrl(request.youtubeVideoId);
  return (
    <li className={`row row--${request.status}${isNext ? ' row--next' : ''}`} data-request-id={request.id}>
      {onSelect && (
        <label className="row__select">
          <input
            type="checkbox"
            checked={selected}
            onChange={(event) => onSelect(request.id, event.target.checked)}
            aria-label={`Select request ${request.sequenceNumber}, ${request.songTitle}`}
          />
        </label>
      )}
      <div className="row__seq" aria-label={`Request number ${request.sequenceNumber}`}>
        #{request.sequenceNumber}
      </div>
      <div className="row__main">
        {isNext && <p className="row__flag">Next up</p>}
        <p className="row__song">{request.songTitle}</p>
        <p className="row__likes">{(request.likeCount ?? 1) === 1 ? '1 like' : `${request.likeCount} likes`}</p>
        {request.artistName && <p className="row__artist">{request.artistName}</p>}
        {youtubeHref && (
          <p className="row__youtube">
            <a href={youtubeHref} target="_blank" rel="noopener noreferrer">
              {request.youtubeTitle?.trim() || 'Open on YouTube'}
            </a>
          </p>
        )}
        <p className="row__meta">
          <span className="row__who">Requested by {request.requesterName}</span>
          <span className="row__time">
            <time dateTime={request.createdAt} title={request.createdAt}>
              {formatTime(request.createdAt)}
            </time>
          </span>
          <span className={`badge badge--${request.status}`}>
            <span aria-hidden="true">{STATUS_SYMBOL[request.status]} </span>
            {label}
          </span>
        </p>
      </div>
      {request.status === 'pending' && onMark && (
        <div className="row__actions">
          <button
            type="button"
            className="button button--played"
            disabled={busy}
            onClick={() => onMark(request.id, 'played')}
            aria-label={`Mark request ${request.sequenceNumber}, ${request.songTitle}, as played`}
          >
            Played
          </button>
          <button
            type="button"
            className="button button--skipped"
            disabled={busy}
            onClick={() => onMark(request.id, 'skipped')}
            aria-label={`Mark request ${request.sequenceNumber}, ${request.songTitle}, as skipped`}
          >
            Skip
          </button>
        </div>
      )}
    </li>
  );
}
