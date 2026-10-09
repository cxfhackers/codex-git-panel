import { useEffect, useRef, useState } from 'react';
import { groupDropPaths, canReturnToUnversioned } from './changes';

const MIME = 'application/x-git-panel-paths';

export default function useGroupDrag({ state, busy, selectedNames, collapsed, setCollapsed, move }) {
  const drag = useRef(null), hover = useRef(null), timer = useRef(null);
  const [dragging, setDragging] = useState(false), [target, setTarget] = useState(null);

  function leave() {
    clearTimeout(timer.current); timer.current = null; hover.current = null; setTarget(null);
  }
  function end() { drag.current = null; setDragging(false); leave(); }
  function expand(groupId) {
    setCollapsed(previous => {
      if (!previous.has(groupId)) return previous;
      const next = new Set(previous); next.delete(groupId); return next;
    });
  }

  useEffect(() => {
    end();
    const escape = event => { if (event.key === 'Escape') end(); };
    window.addEventListener('dragend', end);
    window.addEventListener('drop', end);
    window.addEventListener('blur', end);
    window.addEventListener('keydown', escape);
    return () => {
      clearTimeout(timer.current);
      window.removeEventListener('dragend', end);
      window.removeEventListener('drop', end);
      window.removeEventListener('blur', end);
      window.removeEventListener('keydown', escape);
    };
  }, [state?.root, busy]);

  function start(event, file) {
    const paths = selectedNames.includes(file.path) ? selectedNames : [file.path];
    if (busy || paths.some(path => state.files.find(file => file.path === path)?.conflict)) {
      event.preventDefault(); return;
    }
    drag.current = { root: state.root, paths: [...paths] };
    event.dataTransfer.setData(MIME, JSON.stringify(drag.current));
    event.dataTransfer.effectAllowed = 'move';
    setDragging(true);
  }

  function over(event, groupId) {
    const paths = groupDropPaths(state, drag.current, groupId, busy);
    if (!paths.length) {
      event.dataTransfer.dropEffect = 'none';
      const rejected = !busy && drag.current && state && drag.current.root === state.root && groupId === 'unversioned' && drag.current.paths.some(path => !canReturnToUnversioned(state.files.find(file => file.path === path)));
      if (rejected && hover.current !== groupId) { leave(); hover.current = groupId; setTarget({ id: groupId, reason: '仅限未提交的新文件' }); }
      else if (!rejected) leave();
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    if (hover.current === groupId) return;
    leave(); hover.current = groupId; setTarget({ id: groupId, count: paths.length });
    if (collapsed.has(groupId)) {
      timer.current = setTimeout(() => {
        if (hover.current === groupId) expand(groupId);
      }, 550);
    }
  }

  function drop(event, groupId) {
    // Accept only a drag begun in this panel; external payloads cannot move files.
    if (!drag.current) return;
    event.preventDefault(); event.stopPropagation();
    const paths = groupDropPaths(state, drag.current, groupId, busy);
    end();
    if (paths.length) { expand(groupId); void move(groupId, paths); }
  }

  function exit(event) {
    if (!event.currentTarget.contains(event.relatedTarget)) leave();
  }

  return { dragging, target, start, end, over, drop, exit };
}
