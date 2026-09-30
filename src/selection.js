// Selection is UI-only. The Git index changes only when the caller invokes a batch action.
export function selectPath(visiblePaths, current, anchor, target, { shift = false, additive = false } = {}) {
  if (!visiblePaths.includes(target)) return { paths: new Set(current), anchor };
  const next = new Set(current);
  if (shift && anchor && visiblePaths.includes(anchor)) {
    const start = visiblePaths.indexOf(anchor), end = visiblePaths.indexOf(target);
    const range = visiblePaths.slice(Math.min(start, end), Math.max(start, end) + 1);
    return { paths: new Set(additive ? [...next, ...range] : range), anchor };
  }
  if (additive) {
    if (next.has(target)) next.delete(target); else next.add(target);
    return { paths: next, anchor: target };
  }
  return { paths: new Set([target]), anchor: target };
}
