'use client';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export interface WorktreeMenuSlot { target: HTMLDivElement | null; close: () => void }

/** Keep action state and forms mounted below the controls while their triggers live in a dropdown. */
export function WorktreeMenu({ label, name, open, onOpen, onClose, children }: {
  label: string; name: string; open: boolean; onOpen: () => void; onClose: () => void;
  children: (menu: WorktreeMenuSlot) => ReactNode;
}) {
  const id = useId(); const root = useRef<HTMLDivElement>(null); const button = useRef<HTMLButtonElement>(null);
  const pinned = useRef(false); const [target, setTarget] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) { pinned.current = false; return; }
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) onClose(); };
    const focusOutside = (event: FocusEvent) => { if (!root.current?.contains(event.target as Node)) onClose(); };
    const leave = (event: PointerEvent) => {
      if (event.pointerType === 'mouse' && !pinned.current && !root.current?.contains(document.activeElement)) onClose();
    };
    // Native events follow the menu's DOM, including the action buttons rendered here through portals.
    const keyboard = (event: KeyboardEvent) => {
      if (!root.current?.contains(event.target as Node)) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); button.current?.focus(); }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const items = Array.from(target?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === 'ArrowDown' ? (index + 1) % items.length : (index < 0 ? items.length - 1 : (index - 1 + items.length) % items.length);
        items[next]?.focus();
      }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', focusOutside);
    document.addEventListener('keydown', keyboard);
    const element = root.current; element?.addEventListener('pointerleave', leave);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('focusin', focusOutside); document.removeEventListener('keydown', keyboard); element?.removeEventListener('pointerleave', leave); };
  }, [open, onClose, target]);
  const close = () => { onClose(); button.current?.focus(); };
  return <>
    <div className={`worktree-menu worktree-menu-${label.toLowerCase()}`} ref={root}
      onPointerEnter={(event) => { if (event.pointerType === 'mouse') onOpen(); }}>
      <button ref={button} type="button" className="quiet" aria-label={`${label} actions for ${name}`} aria-expanded={open} aria-controls={id}
        onKeyDown={(event) => {
          if (!open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
            event.preventDefault(); event.stopPropagation(); onOpen();
            requestAnimationFrame(() => {
              const items = target?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
              items?.[event.key === 'ArrowUp' ? items.length - 1 : 0]?.focus();
            });
          }
        }}
        onClick={() => { if (open && pinned.current) onClose(); else { pinned.current = true; onOpen(); } }}>
        {label} <span aria-hidden="true">▾</span>
      </button>
      <div id={id} ref={setTarget} className="worktree-menu-list" role="group" aria-label={`${label} actions for ${name}`} hidden={!open} />
    </div>
    {children({ target, close })}
  </>;
}

export function WorktreeMenuItem({ menu, children }: { menu?: WorktreeMenuSlot; children: ReactNode }) {
  return menu ? menu.target && createPortal(<span className="worktree-menu-item" onClick={menu.close}>{children}</span>, menu.target) : children;
}
