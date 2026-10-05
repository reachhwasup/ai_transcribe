import { useEffect, useRef } from 'react';

/** Only mounted for clips near the playhead, never for every line in a project. */
export default function VoicePlaybackAudio({ id, src, muted, players, initiated }: {
  id: string;
  src: string;
  muted: boolean;
  players: Map<string, HTMLAudioElement>;
  initiated: Map<string, boolean>;
}) {
  const ref = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    const audio = ref.current;
    if (!audio) return;
    // StrictMode re-runs effects after cleanup on the same DOM element.
    audio.setAttribute('src', src);
    players.set(id, audio);
    return () => {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      if (players.get(id) === audio) players.delete(id);
      initiated.delete(id);
    };
  }, [id, src, players, initiated]);
  return <audio ref={ref} src={src} preload="auto" muted={muted} />;
}
