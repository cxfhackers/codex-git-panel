const memory = new Map();
export const storage = {
  get(key) { try { return localStorage.getItem(key) ?? memory.get(key); } catch { return memory.get(key); } },
  set(key, value) { memory.set(key, value); try { localStorage.setItem(key, value); } catch {} },
  remove(key) { memory.delete(key); try { localStorage.removeItem(key); } catch {} },
};
