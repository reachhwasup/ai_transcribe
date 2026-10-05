/** The name the app shows for itself */
export const APP_NAME = 'Dubbing Studio';

/** A series' episodes share a long name and differ only at the end ("… - Episode 001"), so the
 *  end is what is shown in full and the shared start is what gives way. */
export function nameParts(name: string): { head: string; tail: string } {
  const at = name.lastIndexOf(' - ');
  if (at > 0 && name.length - at < 40) return { head: name.slice(0, at), tail: name.slice(at + 3) };
  return { head: '', tail: name };
}

/** The episode a video is, read from the end of its name ("… - Episode 012" → 12); its place
 *  in the folder when the name carries no number. */
export function episodeNumber(name: string, place: number): number {
  const found = nameParts(name).tail.match(/(\d+)(?!.*\d)/);
  return found ? parseInt(found[1], 10) : place;
}

/** "Series - EP012": one name for the series, the number padded so the files sort in order */
export function episodeFileName(series: string, episode: number, total: number): string {
  const width = Math.max(3, String(total).length);
  const clean = series.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim();
  return `${clean ? `${clean} - ` : ''}EP${String(episode).padStart(width, '0')}`;
}
