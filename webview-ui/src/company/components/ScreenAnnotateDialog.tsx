/**
 * ScreenAnnotateDialog: mark up a screen capture before it goes into the prompt. Boxes, arrows,
 * numbered dots, short text and blur (pixelate) are drawn onto the capture itself, so the agent
 * sees exactly what was pointed at, and what was blurred never leaves the machine.
 * Enter or "Xong" attaches the marked image; Esc cancels; Ctrl+Z undoes the last mark.
 */

import { type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { ANNOTATE_LABEL_COLOR, ANNOTATE_MARK_COLOR, ANNOTATE_OUTLINE_COLOR } from '../../constants.js';

type Tool = 'rect' | 'arrow' | 'number' | 'text' | 'blur';

type Mark =
  | { readonly kind: 'rect' | 'arrow' | 'blur'; readonly x1: number; readonly y1: number; readonly x2: number; readonly y2: number }
  | { readonly kind: 'number'; readonly x: number; readonly y: number; readonly n: number }
  | { readonly kind: 'text'; readonly x: number; readonly y: number; readonly text: string };

const TOOLS: readonly { readonly id: Tool; readonly label: string; readonly hint: string }[] = [
  { id: 'rect', label: '▢', hint: 'Khoanh ô' },
  { id: 'arrow', label: '➜', hint: 'Mũi tên' },
  { id: 'number', label: '①', hint: 'Đánh số' },
  { id: 'text', label: 'T', hint: 'Ghi chữ' },
  { id: 'blur', label: '▒', hint: 'Làm mờ chỗ riêng tư' },
];
const BLUR_BLOCK = 14;

export interface ScreenAnnotateDialogProps {
  readonly image: File;
  readonly onDone: (file: File) => void;
  readonly onCancel: () => void;
}

export function ScreenAnnotateDialog({ image, onDone, onCancel }: ScreenAnnotateDialogProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [picture, setPicture] = useState<HTMLImageElement | null>(null);
  const [tool, setTool] = useState<Tool>('rect');
  const [marks, setMarks] = useState<readonly Mark[]>([]);
  const [draft, setDraft] = useState<Mark | null>(null);

  useEffect(() => {
    const url = URL.createObjectURL(image);
    const next = new Image();
    next.onload = () => setPicture(next);
    next.src = url;
    return () => URL.revokeObjectURL(url);
  }, [image]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null || picture === null) return;
    paint(canvas, picture, draft === null ? marks : [...marks, draft]);
  }, [picture, marks, draft]);

  const finish = () => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    canvas.toBlob((blob) => {
      if (blob !== null) onDone(new File([blob], image.name.replace(/\.png$/, '-danh-dau.png'), { type: 'image/png' }));
    }, 'image/png');
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
      else if (event.key === 'Enter') finish();
      else if (event.key.toLowerCase() === 'z' && (event.ctrlKey || event.metaKey)) setMarks((current) => current.slice(0, -1));
      else return;
      event.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const point = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const scale = event.currentTarget.width / box.width;
    return { x: (event.clientX - box.left) * scale, y: (event.clientY - box.top) * scale };
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const { x, y } = point(event);
    if (tool === 'number') {
      setMarks((current) => [...current, { kind: 'number', x, y, n: current.filter((mark) => mark.kind === 'number').length + 1 }]);
      return;
    }
    if (tool === 'text') {
      const text = window.prompt('Ghi chữ lên ảnh')?.trim();
      if (text) setMarks((current) => [...current, { kind: 'text', x, y, text }]);
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    setDraft({ kind: tool, x1: x, y1: y, x2: x, y2: y });
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (draft === null || !('x2' in draft)) return;
    const { x, y } = point(event);
    setDraft({ ...draft, x2: x, y2: y });
  };
  const onPointerUp = () => {
    if (draft === null) return;
    // A click without a drag draws nothing.
    if ('x2' in draft && Math.hypot(draft.x2 - draft.x1, draft.y2 - draft.y1) > 4) setMarks((current) => [...current, draft]);
    setDraft(null);
  };

  return createPortal(
    <div role="dialog" aria-modal="true" aria-label="Đánh dấu ảnh chụp" className="company-ui fixed inset-0 z-[60] flex flex-col bg-black/85">
      <div className="flex flex-wrap items-center gap-1.5 px-3 py-2 text-sm text-text">
        {TOOLS.map((item) => (
          <button
            key={item.id}
            type="button"
            title={item.hint}
            aria-label={item.hint}
            aria-pressed={tool === item.id}
            onClick={() => setTool(item.id)}
            className={`touch-target min-w-9 rounded-(--company-radius-sm) px-2 py-1 text-base ${tool === item.id ? 'bg-selected text-text' : 'bg-raised text-text-secondary hover:bg-hover'}`}
          >
            {item.label}
          </button>
        ))}
        <button type="button" title="Hoàn tác (Ctrl+Z)" onClick={() => setMarks((current) => current.slice(0, -1))} disabled={marks.length === 0} className="touch-target rounded-(--company-radius-sm) bg-raised px-2 py-1 text-text-secondary hover:bg-hover disabled:opacity-40">↶</button>
        <span className="flex-1" />
        <button type="button" onClick={onCancel} className="touch-target rounded-(--company-radius-sm) bg-raised px-3 py-1 text-text-secondary hover:bg-hover">Huỷ</button>
        <button type="button" onClick={finish} className="touch-target rounded-(--company-radius-sm) bg-accent px-3 py-1 text-white">Xong ↵</button>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center p-3">
        {picture === null
          ? <p className="text-sm text-text-muted">Đang mở ảnh…</p>
          : (
            <canvas
              ref={canvasRef}
              width={picture.naturalWidth}
              height={picture.naturalHeight}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={() => setDraft(null)}
              className="max-h-full max-w-full cursor-crosshair touch-none rounded-(--company-radius-sm) shadow-lg"
            />
          )}
      </div>
    </div>,
    document.body,
  );
}

function paint(canvas: HTMLCanvasElement, picture: HTMLImageElement, marks: readonly Mark[]): void {
  const context = canvas.getContext('2d');
  if (context === null) return;
  context.drawImage(picture, 0, 0);
  const width = Math.max(3, Math.round(canvas.width / 400));
  for (const mark of marks) {
    context.strokeStyle = ANNOTATE_MARK_COLOR;
    context.fillStyle = ANNOTATE_MARK_COLOR;
    context.lineWidth = width;
    if (mark.kind === 'rect') {
      context.strokeRect(Math.min(mark.x1, mark.x2), Math.min(mark.y1, mark.y2), Math.abs(mark.x2 - mark.x1), Math.abs(mark.y2 - mark.y1));
    } else if (mark.kind === 'arrow') {
      drawArrow(context, mark.x1, mark.y1, mark.x2, mark.y2, width * 5);
    } else if (mark.kind === 'blur') {
      pixelate(context, picture, mark.x1, mark.y1, mark.x2, mark.y2);
    } else if (mark.kind === 'number') {
      const radius = width * 5;
      context.beginPath();
      context.arc(mark.x, mark.y, radius, 0, Math.PI * 2);
      context.fill();
      context.fillStyle = ANNOTATE_LABEL_COLOR;
      context.font = `bold ${Math.round(radius * 1.2)}px sans-serif`;
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.fillText(String(mark.n), mark.x, mark.y + 1);
    } else if (mark.kind === 'text') {
      const size = width * 7;
      context.font = `bold ${size}px sans-serif`;
      context.textAlign = 'left';
      context.textBaseline = 'top';
      context.lineWidth = width * 1.5;
      context.strokeStyle = ANNOTATE_OUTLINE_COLOR;
      context.strokeText(mark.text, mark.x, mark.y);
      context.fillText(mark.text, mark.x, mark.y);
    }
  }
}

function drawArrow(context: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number, head: number): void {
  const angle = Math.atan2(y2 - y1, x2 - x1);
  context.beginPath();
  context.moveTo(x1, y1);
  context.lineTo(x2, y2);
  context.stroke();
  context.beginPath();
  context.moveTo(x2, y2);
  context.lineTo(x2 - head * Math.cos(angle - Math.PI / 6), y2 - head * Math.sin(angle - Math.PI / 6));
  context.lineTo(x2 - head * Math.cos(angle + Math.PI / 6), y2 - head * Math.sin(angle + Math.PI / 6));
  context.closePath();
  context.fill();
}

/** Redraws the area from the original picture in coarse blocks, so no detail stays readable. */
function pixelate(context: CanvasRenderingContext2D, picture: HTMLImageElement, x1: number, y1: number, x2: number, y2: number): void {
  const x = Math.round(Math.min(x1, x2));
  const y = Math.round(Math.min(y1, y2));
  const width = Math.round(Math.abs(x2 - x1));
  const height = Math.round(Math.abs(y2 - y1));
  if (width < 2 || height < 2) return;
  const small = document.createElement('canvas');
  small.width = Math.max(1, Math.ceil(width / BLUR_BLOCK));
  small.height = Math.max(1, Math.ceil(height / BLUR_BLOCK));
  small.getContext('2d')?.drawImage(picture, x, y, width, height, 0, 0, small.width, small.height);
  context.imageSmoothingEnabled = false;
  context.drawImage(small, 0, 0, small.width, small.height, x, y, width, height);
  context.imageSmoothingEnabled = true;
}
