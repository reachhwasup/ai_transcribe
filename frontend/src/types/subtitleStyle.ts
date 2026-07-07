// Burned-in subtitle caption style — shared by the live previews and export.
export interface SubtitleStyle {
  sizePct: number;                 // text height as % of frame height
  position: 'bottom' | 'middle' | 'top';
  textColor: string;               // #RRGGBB
  outlineColor: string;            // #RRGGBB
  outlineWidth: number;            // px of stroke around glyphs (0 = none)
  boxColor: string;                // #RRGGBB background box fill
  boxOpacity: number;              // 0–1 (0 = no box)
  boxOutlineColor: string;         // #RRGGBB box border
  boxOutlineWidth: number;         // px of box border (0 = none)
}

export const DEFAULT_SUBTITLE_STYLE: SubtitleStyle = {
  sizePct: 4,
  position: 'bottom',
  textColor: '#FFFFFF',
  outlineColor: '#000000',
  outlineWidth: 2,
  boxColor: '#000000',
  boxOpacity: 0.55,
  boxOutlineColor: '#000000',
  boxOutlineWidth: 0,
};

/** Turn "#RRGGBB" + opacity into an rgba() string for CSS previews. */
export function hexToRgba(hex: string, opacity = 1): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16) || 0;
  const g = parseInt(h.slice(2, 4), 16) || 0;
  const b = parseInt(h.slice(4, 6), 16) || 0;
  return `rgba(${r}, ${g}, ${b}, ${opacity})`;
}
