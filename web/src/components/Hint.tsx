'use client';
import { useId, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';

/** Help text shown on hover, keyboard focus and tap. A native title alone is invisible on touch screens, so the text also
 * describes the control for assistive technology. `end` anchors the bubble to the right edge for controls near it. */
function Bubble({ id, help, align }: { id: string; help: ReactNode; align?: 'start' | 'end' }) {
  return <span id={id} role="tooltip" className={`hint-bubble${align === 'end' ? ' end' : ''}`}>{help}</span>;
}

/** A compact status emoji with an accessible name. Tapping or focusing it shows what it means and what to do next. */
export function StatusIcon({ icon, label, help, align }: { icon: string; label: string; help: ReactNode; align?: 'start' | 'end' }) {
  const id = useId(); const [open, setOpen] = useState(false);
  return <span className={`hint${open ? ' open' : ''}`}>
    <span role="img" aria-label={label} aria-describedby={id} tabIndex={0} className="status-icon" onClick={() => setOpen((o) => !o)} onBlur={() => setOpen(false)}
      onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false); else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen((o) => !o); } }}>{icon}</span>
    <Bubble id={id} help={help} align={align} /></span>;
}

/** An icon-only button that keeps a full accessible name; its help appears on hover and keyboard focus. */
export function IconButton({ icon, label, help, align, className, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { icon: string; label: string; help: ReactNode; align?: 'start' | 'end' }) {
  const id = useId();
  return <span className="hint"><button type="button" {...props} className={`icon-button${className ? ` ${className}` : ''}`} aria-label={label} aria-describedby={id}>{icon}</button>
    <Bubble id={id} help={help} align={align} /></span>;
}

/** A small "?" that explains the control beside it; tap, click or focus shows the text. */
export function HelpTip({ label, help }: { label: string; help: ReactNode }) {
  const id = useId(); const [open, setOpen] = useState(false);
  return <span className={`hint${open ? ' open' : ''}`}>
    <button type="button" className="help-tip" aria-label={label} aria-describedby={id} aria-expanded={open} onClick={() => setOpen((o) => !o)} onBlur={() => setOpen(false)}
      onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false); }}>?</button>
    <Bubble id={id} help={help} /></span>;
}
