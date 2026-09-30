import { useEffect, useState } from 'react';
import { request } from './api';

export function useRepositoryWatch(id, context, pending, stagingQueue, acceptState) {
  const [status, setStatus] = useState(''), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!id) { setStatus(''); return; }
    const client = crypto.randomUUID();
    let disposed = false, running = false, version = '', timer, dirty = true, retry = 2000, generation = 0;
    const visible = () => document.visibilityState !== 'hidden';
    function schedule(delay) { clearTimeout(timer); if (!disposed && visible()) timer = setTimeout(run, delay); }
    async function run() {
      if (disposed || !visible() || running) return;
      running = true; const epoch = generation;
      try {
        if (pending.current || stagingQueue.current.size) { schedule(700); return; }
        if (dirty) {
          const previous = context.current.state;
          const next = await request(`/api/state?id=${id}`);
          if (disposed || epoch !== generation || !visible()) return;
          // Never replace a newer mutation result with a background read.
          if (context.current.id === id && context.current.state === previous && !pending.current && !stagingQueue.current.size) {
            acceptState(next);
            dirty = false;
          }
          if (dirty) { schedule(1000); return; }
        }
        const result = await request(`/api/watch?id=${id}`, { client, version });
        if (disposed || epoch !== generation || !visible()) return;
        version = result.version; dirty ||= result.changed || result.closed;
        setStatus(result.degraded ? '自动同步 · 低频兜底' : '自动同步'); retry = 2000;
        schedule(dirty ? 400 : 0);
      } catch { if (!disposed) { setStatus('自动同步重连中'); schedule(retry); retry = Math.min(retry * 2, 30000); } }
      finally { running = false; if (!disposed && epoch !== generation && visible()) schedule(0); }
    }
    function stop() { clearTimeout(timer); ++generation; request(`/api/watch-stop?id=${id}`, { client }).catch(() => {}); }
    function visibility() {
      if (!visible()) { stop(); setStatus('自动同步已暂停'); }
      else { dirty = true; version = ''; schedule(0); }
    }
    function focus() { if (visible()) { dirty = true; version = ''; stop(); schedule(0); } }
    document.addEventListener('visibilitychange', visibility); window.addEventListener('focus', focus); window.addEventListener('pagehide', stop);
    schedule(0);
    return () => { disposed = true; stop(); document.removeEventListener('visibilitychange', visibility); window.removeEventListener('focus', focus); window.removeEventListener('pagehide', stop); };
  }, [id, attempt]);
  return { status, failed: status === '自动同步重连中', retry: () => setAttempt(n => n + 1) };
}
