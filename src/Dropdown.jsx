import React, { useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';

const hasPopover = typeof HTMLElement !== 'undefined' && typeof HTMLElement.prototype.showPopover === 'function';

export default function Dropdown({ id, label, value, options, onChange, disabled = false, placeholder = '请选择…', title, className = '' }) {
  const generatedId = useId(), menuId = id ? `${id}-options` : `dropdown-${generatedId}`;
  const trigger = useRef(null), menu = useRef(null);
  const [open, setOpen] = useState(false);
  const selected = options.find(option => option.value === value);

  function close(restoreFocus = false) {
    if (hasPopover && menu.current?.matches(':popover-open')) menu.current.hidePopover();
    setOpen(false);
    if (restoreFocus) trigger.current?.focus();
  }

  function show(focus = 'selected') {
    if (disabled || !options.length || !menu.current || !trigger.current) return;
    const rect = trigger.current.getBoundingClientRect();
    const width = Math.min(Math.max(rect.width, 190), window.innerWidth - 16);
    const below = window.innerHeight - rect.bottom - 8, above = rect.top - 8;
    const upward = below < Math.min(240, options.length * 38 + 8) && above > below;
    const height = Math.max(60, Math.min(320, upward ? above : below));
    Object.assign(menu.current.style, {
      width: `${width}px`, maxHeight: `${height}px`,
      left: `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`,
      top: `${upward ? Math.max(8, rect.top - height - 4) : rect.bottom + 4}px`,
    });
    if (hasPopover) menu.current.showPopover();
    setOpen(true);
    requestAnimationFrame(() => {
      const items = [...(menu.current?.querySelectorAll('.dropdown-option') || [])];
      (focus === 'first' ? items[0] : focus === 'last' ? items.at(-1) : items.find(item => item.dataset.value === value) || items[0])?.focus();
    });
  }

  useEffect(() => { if (disabled && open) close(); }, [disabled, open]);
  useEffect(() => {
    if (!open) return;
    const dismissOnMove = event => { if (!menu.current?.contains(event.target)) close(); };
    const dismissOutside = event => {
      if (!menu.current?.contains(event.target) && !trigger.current?.contains(event.target)) close();
    };
    window.addEventListener('resize', dismissOnMove);
    window.addEventListener('scroll', dismissOnMove, true);
    if (!hasPopover) document.addEventListener('pointerdown', dismissOutside, true);
    return () => {
      window.removeEventListener('resize', dismissOnMove);
      window.removeEventListener('scroll', dismissOnMove, true);
      if (!hasPopover) document.removeEventListener('pointerdown', dismissOutside, true);
    };
  }, [open]);

  function menuKeyDown(event) {
    const items = [...menu.current.querySelectorAll('.dropdown-option')];
    const index = items.indexOf(document.activeElement);
    if (event.key === 'Escape') { event.preventDefault(); close(true); return; }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    }
  }

  return <div className={`dropdown ${className}`}>
    <button ref={trigger} id={id} type="button" className="dropdown-trigger" aria-label={label} aria-expanded={open} aria-controls={menuId} title={title} disabled={disabled} onClick={() => open ? close(true) : show()} onKeyDown={event => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); show(event.key === 'ArrowDown' ? 'first' : 'last'); }
    }}>
      <span className="dropdown-value">{selected?.label || placeholder}</span><ChevronDown size={15} aria-hidden="true"/>
    </button>
    <div ref={menu} id={menuId} popover={hasPopover ? 'auto' : undefined} className="dropdown-popover" style={!hasPopover ? { display: open ? 'block' : 'none' } : undefined} role="group" aria-label={`${label}选项`} onToggle={hasPopover ? event => setOpen(event.currentTarget.matches(':popover-open')) : undefined} onKeyDown={menuKeyDown} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) close(); }}>
      {options.map(option => <button key={option.value} type="button" className="dropdown-option" data-value={option.value} aria-pressed={option.value === value} title={option.label} onClick={() => { close(true); if (option.value !== value) onChange(option.value); }}><span>{option.label}</span>{option.value === value && <Check size={14} aria-hidden="true"/>}</button>)}
    </div>
  </div>;
}
