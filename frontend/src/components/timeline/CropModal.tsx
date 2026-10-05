import { Crop, Loader2, X } from 'lucide-react';
import { createPortal } from 'react-dom';

export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Props {
  rect: CropRect;
  onChange: (rect: CropRect) => void;
  onApply: () => void;
  onClose: () => void;
  busy: boolean;
}

const FIELDS: { key: keyof CropRect; label: string; min: number }[] = [
  { key: 'x', label: 'X (left)', min: 0 },
  { key: 'y', label: 'Y (top)', min: 0 },
  { key: 'w', label: 'Width', min: 2 },
  { key: 'h', label: 'Height', min: 2 },
];

export default function CropModal({ rect, onChange, onApply, onClose, busy }: Props) {
  // Rendered from a panel whose ancestors are transformed, which would otherwise box this
  // dialog inside that panel instead of the viewport.
  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl w-full max-w-md p-5 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-white flex items-center gap-2"><Crop className="w-4 h-4" /> Crop Video</h3>
          <button onClick={onClose} className="p-1 rounded hover:bg-zinc-700 transition-colors">
            <X className="w-4 h-4 text-zinc-400" />
          </button>
        </div>

        <div className="grid grid-cols-2 gap-3">
          {FIELDS.map(({ key, label, min }) => (
            <div key={key}>
              <label className="text-[11px] text-zinc-400 uppercase tracking-wide block mb-1">{label}</label>
              <input
                type="number"
                value={rect[key]}
                onChange={(e) => onChange({ ...rect, [key]: Math.max(min, parseInt(e.target.value) || min) })}
                min={min}
                className="w-full px-3 py-2 bg-zinc-800 border border-zinc-600 rounded-lg text-sm text-white font-mono focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30"
              />
            </div>
          ))}
        </div>

        <p className="text-[10px] text-zinc-500">Crop region is measured in pixels from the top-left corner of the video.</p>

        <div className="flex justify-end gap-2 pt-1">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-xs font-medium text-zinc-300 bg-zinc-700 hover:bg-zinc-600 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onApply}
            disabled={busy}
            className="px-4 py-2 rounded-lg text-xs font-medium text-white bg-blue-600 hover:bg-blue-500 transition-colors disabled:opacity-50 flex items-center gap-1.5"
          >
            {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            Crop
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
