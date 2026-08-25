// Burned-in subtitle caption style — shared by the live previews and export.
export interface SubtitleStyle {
  fontFamily?: string;             // Font family name or CSS font stack
  fontSize?: number;               // Explicit font size in px (e.g. 24, 32, 40)
  fontWeight?: 'normal' | 'bold' | '900';
  sizePct: number;                 // text height as % of frame height
  position: 'bottom' | 'middle' | 'top';
  textAlign?: 'left' | 'center' | 'right';
  textColor: string;               // #RRGGBB
  outlineColor: string;            // #RRGGBB
  outlineWidth: number;            // px of stroke around glyphs (0 = none)
  boxColor: string;                // #RRGGBB background box fill
  boxOpacity: number;              // 0–1 (0 = no box)
  boxOutlineColor: string;         // #RRGGBB box border
  boxOutlineWidth: number;         // px of box border (0 = none)
  letterSpacing?: number;          // px spacing between characters
  lineHeight?: number;             // line height ratio (e.g. 1.3)
  textTransform?: 'none' | 'uppercase' | 'lowercase' | 'capitalize';
  textShadow?: 'none' | 'soft' | 'hard' | 'glow';
  borderRadius?: number;           // px of background box corner radius
  animation?: 'none' | 'karaoke' | 'pop' | 'glow' | 'slide' | 'wave' | 'typewriter' | 'badge';
  activeWordColor?: string;        // highlight color for karaoke word
  highlightStyle?: 'color' | 'badge' | 'scale' | 'glow'; // how the active word is highlighted
}

export const FONT_OPTIONS = [
  { label: 'Kantumruy Pro', value: "'Kantumruy Pro', sans-serif", category: 'Khmer/Modern' },
  { label: 'Battambang', value: "'Battambang', 'Khmer OS Battambang', sans-serif", category: 'Khmer' },
  { label: 'Moul', value: "'Moul', 'Khmer OS Moul', cursive", category: 'Khmer Display' },
  { label: 'Koulen', value: "'Koulen', cursive", category: 'Khmer Bold' },
  { label: 'Siemreap', value: "'Siemreap', sans-serif", category: 'Khmer' },
  { label: 'Hanuman', value: "'Hanuman', serif", category: 'Khmer Serif' },
  { label: 'Inter', value: "'Inter', sans-serif", category: 'Modern' },
  { label: 'Outfit', value: "'Outfit', sans-serif", category: 'Geometric' },
  { label: 'Montserrat', value: "'Montserrat', sans-serif", category: 'Clean' },
  { label: 'Bebas Neue', value: "'Bebas Neue', sans-serif", category: 'Headline' },
  { label: 'Impact', value: "'Impact', sans-serif", category: 'Bold' },
  { label: 'Poppins', value: "'Poppins', sans-serif", category: 'Rounded' },
];

export const DEFAULT_SUBTITLE_STYLE: SubtitleStyle = {
  fontFamily: "'Kantumruy Pro', sans-serif",
  fontSize: 28,
  fontWeight: 'bold',
  sizePct: 4.5,
  position: 'bottom',
  textAlign: 'center',
  textColor: '#FFFFFF',
  outlineColor: '#000000',
  outlineWidth: 2,
  boxColor: '#000000',
  boxOpacity: 0.6,
  boxOutlineColor: '#000000',
  boxOutlineWidth: 0,
  letterSpacing: 0,
  lineHeight: 1.3,
  textTransform: 'none',
  textShadow: 'none',
  borderRadius: 6,
  animation: 'none',
  activeWordColor: '#facc15',
};

/** Turn "#RRGGBB" + opacity into an rgba() string for CSS previews. */
export function hexToRgba(hex: string, opacity = 1): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16) || 0;
  const g = parseInt(h.slice(2, 4), 16) || 0;
  const b = parseInt(h.slice(4, 6), 16) || 0;
  return `rgba(${r}, ${g}, ${b}, ${opacity})`;
}
