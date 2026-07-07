import type { SubtitleStyle } from '../types/subtitleStyle';
import { hexToRgba } from '../types/subtitleStyle';

interface Props {
  text: string;
  style: SubtitleStyle;
  /** Height of the preview box in px, used to scale sizePct to real pixels. */
  frameHeight?: number;
}

/** Renders a caption exactly as the export will burn it: text fill + outline,
 *  optional background box with its own fill and border. Purely visual. */
export default function SubtitleOverlay({ text, style, frameHeight = 300 }: Props) {
  const posCls =
    style.position === 'top' ? 'top-[4%]'
      : style.position === 'middle' ? 'top-1/2 -translate-y-1/2'
      : 'bottom-[6%]';

  const fontSize = Math.max(9, Math.round((frameHeight * style.sizePct) / 100));
  const ow = style.outlineWidth;
  // Multi-directional text-shadow approximates a stroke around the glyphs.
  const stroke = ow > 0
    ? [`${ow}px ${ow}px`, `-${ow}px ${ow}px`, `${ow}px -${ow}px`, `-${ow}px -${ow}px`,
       `${ow}px 0`, `-${ow}px 0`, `0 ${ow}px`, `0 -${ow}px`]
        .map((o) => `${o} 0 ${style.outlineColor}`).join(', ')
    : undefined;

  return (
    <div className={`absolute left-[3%] right-[3%] ${posCls} text-center pointer-events-none`}>
      <span
        className="inline-block leading-snug max-w-full"
        style={{
          fontSize: `${fontSize}px`,
          padding: `${fontSize * 0.12}px ${fontSize * 0.3}px`,
          color: style.textColor,
          textShadow: stroke,
          backgroundColor: style.boxOpacity > 0 ? hexToRgba(style.boxColor, style.boxOpacity) : 'transparent',
          border: style.boxOutlineWidth > 0 ? `${style.boxOutlineWidth}px solid ${style.boxOutlineColor}` : undefined,
          borderRadius: '4px',
        }}
      >
        {text}
      </span>
    </div>
  );
}
