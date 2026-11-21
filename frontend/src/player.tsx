import { useCallback, useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';
import { Badge, Dot } from './ui';

type PlayerState = 'connecting' | 'playing' | 'error';
type Quality = 'good' | 'fair' | 'poor' | 'unknown';

export function HlsPlayer({
  src,
  title,
  onSnapshot,
  snapshotBusy = false,
  compact = false,
}: {
  src: string;
  title: string;
  onSnapshot?: () => void;
  snapshotBusy?: boolean;
  compact?: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const [state, setState] = useState<PlayerState>('connecting');
  const [error, setError] = useState<string>('');
  const [muted, setMuted] = useState(true);
  const [quality, setQuality] = useState<Quality>('unknown');
  const [nonce, setNonce] = useState(0);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const reload = useCallback(() => {
    setError('');
    setState('connecting');
    setQuality('unknown');
    setNonce((n) => n + 1);
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !src) return;
    let destroyed = false;
    let networkRetry = 0;

    const fail = (message: string) => {
      if (destroyed) return;
      setState('error');
      setError(message);
    };

    if (Hls.isSupported()) {
      const hls = new Hls({
        lowLatencyMode: true,
        liveSyncDurationCount: 2,
        maxBufferLength: 4,
        backBufferLength: 4,
        manifestLoadingTimeOut: 15_000,
        fragLoadingTimeOut: 20_000,
      });
      hlsRef.current = hls;
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (destroyed) return;
        setState('playing');
        video.play().catch(() => {
          /* autoplay can be blocked; the mute control lets the owner start playback */
        });
      });
      hls.on(Hls.Events.FRAG_LOADED, (_event, data) => {
        const duration = data.frag?.duration ?? 0;
        const stats = (data as unknown as { stats?: { loading?: { start?: number; end?: number } } }).stats;
        const loading = stats?.loading;
        if (!duration || !loading?.start || !loading.end) return;
        const ratio = (loading.end - loading.start) / (duration * 1000);
        setQuality(ratio < 0.35 ? 'good' : ratio < 0.9 ? 'fair' : 'poor');
      });
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (destroyed || !data.fatal) return;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR && networkRetry < 3) {
          networkRetry += 1;
          window.setTimeout(() => {
            if (!destroyed) hls.startLoad();
          }, 1500 * networkRetry);
          return;
        }
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && networkRetry < 2) {
          networkRetry += 1;
          hls.recoverMediaError();
          return;
        }
        fail(
          data.type === Hls.ErrorTypes.NETWORK_ERROR
            ? 'Live stream loading failed. Check that the camera is online and the gateway can reach the DVR.'
            : 'The live stream could not be decoded. Try reconnecting.',
        );
      });
      hls.loadSource(src);
      hls.attachMedia(video);
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = src;
      video.addEventListener('loadedmetadata', () => setState('playing'), { once: true });
      video.addEventListener('error', () => fail('This browser could not play the live stream.'), { once: true });
      video.play().catch(() => {});
    } else {
      fail('HLS playback is not supported in this browser.');
    }

    return () => {
      destroyed = true;
      const hls = hlsRef.current;
      hlsRef.current = null;
      if (hls) hls.destroy();
      video.removeAttribute('src');
      video.load();
    };
  }, [src, nonce]);

  useEffect(() => {
    const onChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  function toggleFullscreen() {
    const wrap = wrapRef.current;
    const video = videoRef.current as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null;
    if (!wrap) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen();
      return;
    }
    if (wrap.requestFullscreen) {
      wrap.requestFullscreen().catch(() => {
        if (video?.webkitEnterFullscreen) video.webkitEnterFullscreen();
      });
    } else if (video?.webkitEnterFullscreen) {
      video.webkitEnterFullscreen();
    }
  }

  const qualityLabel = quality === 'unknown' ? 'measuring' : quality;
  const qualityTone = quality === 'good' ? 'ok' : quality === 'fair' ? 'warn' : quality === 'poor' ? 'bad' : 'idle';

  return (
    <div className={`player${compact ? ' compact' : ''}`} ref={wrapRef}>
      <video ref={videoRef} playsInline muted={muted} autoPlay controls={false} className="player-video" />
      <div className="player-top">
        <span className="live-pill">
          <Dot tone={state === 'playing' ? 'ok' : state === 'error' ? 'bad' : 'warn'} pulse={state === 'playing'} />
          {state === 'playing' ? 'LIVE' : state === 'error' ? 'OFFLINE' : 'CONNECTING'}
        </span>
        <span className="player-title">{title}</span>
        <Badge tone={qualityTone as 'ok' | 'warn' | 'bad' | 'idle'}>{qualityLabel}</Badge>
      </div>
      {state !== 'playing' ? (
        <div className={`player-overlay${state === 'error' ? ' is-error' : ''}`}>
          {state === 'connecting' ? (
            <>
              <span className="spinner" />
              <p>Starting camera stream…</p>
            </>
          ) : (
            <>
              <p>{error || 'Stream unavailable'}</p>
              <button type="button" className="btn btn-small" onClick={reload}>
                Reconnect
              </button>
            </>
          )}
        </div>
      ) : null}
      <div className="player-controls">
        <button type="button" className="btn btn-small" onClick={() => setMuted((m) => !m)} aria-label={muted ? 'Unmute' : 'Mute'}>
          {muted ? 'Unmute' : 'Mute'}
        </button>
        {onSnapshot ? (
          <button type="button" className="btn btn-small" onClick={onSnapshot} disabled={snapshotBusy}>
            {snapshotBusy ? 'Saving…' : 'Snapshot'}
          </button>
        ) : null}
        <button type="button" className="btn btn-small" onClick={reload}>
          Reconnect
        </button>
        <button type="button" className="btn btn-small" onClick={toggleFullscreen}>
          {isFullscreen ? 'Exit full screen' : 'Full screen'}
        </button>
      </div>
    </div>
  );
}
