// Keep optimistic display separate from the confirmed Git revision used by every write.
export function previewStaging(files, pending) {
  const result = new Map(files.map(file => [file.path, file]));
  for (const item of pending) {
    const file = result.get(item.path) || item.file;
    const kind = file.kind === '?' ? 'A' : file.kind;
    result.set(item.path, { ...file, pending: true, staged: item.staged, unstaged: !item.staged,
      code: item.staged ? kind + ' ' : file.code[0] === 'A' || file.code === '??' ? '??' : ' ' + kind });
  }
  return [...result.values()];
}

export function createStagingQueue({ getContext, send, read, onState, onPending, onError }) {
  const items = new Map();
  let running = false, scheduled = false, version = 0;
  const notify = () => onPending([...items.values()]);
  async function drain() {
    scheduled = false;
    if (running) return;
    running = true;
    try {
      while (items.size) {
        const context = getContext(), first = items.values().next().value;
        const batch = [...items.values()].filter(item => item.staged === first.staged).slice(0, 500);
        const result = await send(context.id, { action: 'set-staging', revision: context.state.revision, paths: batch.map(item => item.path), staged: first.staged });
        if (getContext().id !== context.id) { items.clear(); break; }
        onState(result.state);
        for (const item of batch) if (items.get(item.path)?.version === item.version) items.delete(item.path);
        notify();
      }
    } catch (error) {
      const context = getContext();
      let refreshed = false;
      // Never turn optimistic selections into a commit after a failed or stale write.
      try { const state = await read(context.id); if (getContext().id === context.id) { onState(state); refreshed = true; } }
      catch (refreshError) { error = new Error(error.message + '\n状态读取失败，请刷新后再操作：' + refreshError.message); }
      items.clear();
      onError(refreshed ? error.message.replace(/请刷新后重新核对|请刷新后核对|请刷新/g, '请核对文件后重试') + '\n已自动同步实际暂存状态，未完成的选择已回退。' : error.message);
    } finally { running = false; notify(); }
  }
  return {
    get size() { return items.size; },
    enqueue(files, staged) {
      for (const file of files) items.set(file.path, { path: file.path, file, staged, version: ++version });
      notify();
      if (!running && !scheduled) { scheduled = true; queueMicrotask(drain); }
    },
  };
}
