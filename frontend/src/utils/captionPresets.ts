import { DEFAULT_SUBTITLE_STYLE, type SubtitleStyle } from '../types/subtitleStyle';

/** Caption looks: the built-in ones and the ones saved in this browser. Shared by the Style tab
 *  and by anything that sets a project's style without opening it. */
export interface Preset {
  id: string;
  name: string;
  desc: string;
  style: Partial<SubtitleStyle>;
}
// `fontSize` is a pixel size on a 720-high frame, converted to a share of the frame on apply
export const PRESET_TEMPLATES: Preset[] = [
  {
    id: 'meatika_classic',
    name: 'Meatika Classic',
    desc: 'White on a dark box, word highlight',
    style: {
      fontFamily: "'Kantumruy Pro', sans-serif", fontSize: 30, fontWeight: 'bold', textColor: '#FFFFFF',
      boxColor: '#000000', boxOpacity: 0.65, boxOutlineWidth: 0, outlineWidth: 2, outlineColor: '#000000',
      borderRadius: 8, animation: 'karaoke', activeWordColor: '#facc15',
    },
  },
  {
    id: 'shorts_bold',
    name: 'Shorts Bold',
    desc: 'Heavy white, thick outline, no box',
    style: {
      fontFamily: "'Kantumruy Pro', sans-serif", fontSize: 36, fontWeight: '900', textColor: '#FFFFFF',
      boxOpacity: 0, outlineWidth: 5, outlineColor: '#000000', textShadow: 'hard',
      animation: 'karaoke', activeWordColor: '#facc15',
    },
  },
  {
    id: 'cinema_clean',
    name: 'Cinema Clean',
    desc: 'Thin outline and a soft shadow',
    style: {
      fontFamily: "'Inter', sans-serif", fontSize: 26, fontWeight: 'bold', textColor: '#FFFFFF',
      boxOpacity: 0, outlineWidth: 1.5, outlineColor: '#000000', textShadow: 'soft', borderRadius: 4,
      animation: 'none',
    },
  },
  {
    id: 'boxed_yellow',
    name: 'Boxed Yellow',
    desc: 'Yellow text on a solid black box',
    style: {
      fontFamily: "'Battambang', 'Khmer OS Battambang', sans-serif", fontSize: 28, fontWeight: 'bold',
      textColor: '#facc15', boxColor: '#000000', boxOpacity: 0.9, outlineWidth: 0, borderRadius: 4,
      animation: 'none',
    },
  },
  {
    id: 'word_badge',
    name: 'Word Badge',
    desc: 'The spoken word sits on a coloured badge',
    style: {
      fontFamily: "'Kantumruy Pro', sans-serif", fontSize: 32, fontWeight: '900', textColor: '#FFFFFF',
      boxOpacity: 0, outlineWidth: 3, outlineColor: '#000000', animation: 'badge', highlightStyle: 'badge',
      activeWordColor: '#2563eb',
    },
  },
  {
    id: 'moul_royal',
    name: 'Moul Royal',
    desc: 'Traditional Khmer display, gold on brown',
    style: {
      fontFamily: "'Moul', 'Khmer OS Moul', cursive", fontSize: 32, fontWeight: 'bold', textColor: '#fef08a',
      outlineWidth: 3, outlineColor: '#854d0e', boxColor: '#451a03', boxOpacity: 0.8, boxOutlineColor: '#ca8a04',
      boxOutlineWidth: 1.5, borderRadius: 10, animation: 'none',
    },
  },
  {
    id: 'cyber_neon',
    name: 'Cyber Neon',
    desc: 'Cyan Bebas Neue with a glow',
    style: {
      fontFamily: "'Bebas Neue', sans-serif", fontSize: 36, fontWeight: 'bold', textColor: '#38bdf8',
      boxOpacity: 0, outlineWidth: 0, textShadow: 'glow', animation: 'none', textTransform: 'uppercase',
      letterSpacing: 2,
    },
  },
  {
    id: 'pill_karaoke',
    name: 'Pill Karaoke',
    desc: 'Koulen in a rounded pill, word highlight',
    style: {
      fontFamily: "'Koulen', cursive", fontSize: 32, fontWeight: 'bold', textColor: '#FFFFFF',
      boxColor: '#1e1b4b', boxOpacity: 0.85, boxOutlineColor: '#6366f1', boxOutlineWidth: 2,
      borderRadius: 999, animation: 'karaoke', activeWordColor: '#fbbf24',
    },
  },
];

export const SAVED_PRESETS_KEY = 'meatika-caption-presets';

// Position and alignment belong to the video being worked on, so a preset never changes them
export const withoutPlacement = ({ position: _p, textAlign: _a, ...rest }: Partial<SubtitleStyle>) => rest;

export function loadSavedPresets(): Preset[] {
  try {
    const value = JSON.parse(localStorage.getItem(SAVED_PRESETS_KEY) || '[]');
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

/** The full style a preset gives, keeping the placement of `current`. */
export function styleFromPreset(preset: Partial<SubtitleStyle>, current: Pick<SubtitleStyle, 'position' | 'textAlign'>): SubtitleStyle {
  const { fontSize, ...rest } = withoutPlacement(preset);
  return {
    ...DEFAULT_SUBTITLE_STYLE,
    highlightStyle: 'color',
    ...rest,
    // presets were written in pixels on a 720-high frame; size is a share of the frame now
    sizePct: fontSize ? Number((fontSize / 5.4).toFixed(2)) : (rest.sizePct ?? DEFAULT_SUBTITLE_STYLE.sizePct),
    fontSize: undefined,
    position: current.position,
    textAlign: current.textAlign,
  };
}
