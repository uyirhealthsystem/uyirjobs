import { useState } from 'react';

// A YouTube video that costs nothing until tapped: shows the thumbnail with a play button, and
// loads the (privacy-enhanced, no-cookie) player only when the viewer taps it. Saves mobile data.
export function YouTube({ id, title }) {
  const [playing, setPlaying] = useState(false);
  return (
    <div className="yt">
      {playing ? (
        <iframe
          src={`https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0&playsinline=1`}
          title={title}
          allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
          allowFullScreen
          // YouTube needs to know which site embeds it; the rest of the site sends no referrer.
          referrerPolicy="strict-origin-when-cross-origin"
        />
      ) : (
        <button type="button" onClick={() => setPlaying(true)} aria-label={`Play video: ${title}`}>
          <img src={`https://i.ytimg.com/vi/${id}/hqdefault.jpg`} alt="" loading="lazy" />
          <span className="yt-play" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
