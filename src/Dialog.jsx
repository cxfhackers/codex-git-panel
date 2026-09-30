import React, { useEffect, useRef } from 'react';

export default function Dialog({ busy = false, onClose, children, ...props }) {
  const ref = useRef(null), outsideDown = useRef(false), mounted = useRef(false);
  useEffect(() => {
    const dialog = ref.current;
    mounted.current = true;
    const previous = document.activeElement;
    dialog.showModal();
    dialog.querySelector('[data-dialog-autofocus]')?.focus();
    return () => {
      mounted.current = false;
      if (dialog.open) dialog.close();
      if (!previous?.isConnected && !document.querySelector('dialog[open]')) document.querySelector('.toolbar .branch')?.focus();
    };
  }, []);
  function outside(event) {
    if (event.target !== ref.current) return false;
    const rect = ref.current.getBoundingClientRect();
    return event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom;
  }
  return <dialog {...props} ref={ref} closedby={busy ? 'none' : 'any'}
    onCancel={event => { if (busy) event.preventDefault(); }} onClose={() => { if (mounted.current) onClose(); }}
    onPointerDown={event => { outsideDown.current = outside(event); }}
    onClick={event => {
      // Older embedded browsers need light dismiss; do not dismiss padding or drags from inside.
      if (!busy && !('closedBy' in HTMLDialogElement.prototype) && outsideDown.current && outside(event)) ref.current.close();
      outsideDown.current = false;
    }}>{children}</dialog>;
}
