export function changeGroups(files, metadata = {}) {
  const groups = (metadata.groups || [{ id: 'changes', name: '更改' }]).map(group => ({ ...group, files: [], type: 'list' }));
  const fallback = groups.find(g => g.id === metadata.activeId) || groups[0];
  const excluded = { id: 'excluded', name: '永不提交', files: [], type: 'protected' };
  const unversioned = { id: 'unversioned', name: '未受版本控制', files: [], type: 'unversioned' };
  for (const file of files) {
    const group = file.excluded ? excluded : file.code === '??' ? unversioned : groups.find(g => g.id === metadata.assignments?.[file.path]) || fallback;
    group.files.push(file);
  }
  return [...groups, excluded, unversioned];
}
export function commitPaths(files, included) { return files.filter(f => included.has(f.path) && !f.excluded && !f.conflict).map(f => f.path); }
export function canReturnToUnversioned(file) {
  return !!file && !file.conflict && !file.oldPath && (file.code === '??' || /^A[^D]$/.test(file.code) || file.code === ' A');
}
export function autoAddPaths(state) {
  const manual = new Set(state.changelists?.manualUntracked || []);
  return state.files.filter(file => file.code === '??' && !file.excluded && !manual.has(file.path)).map(file => file.path).slice(0, 500);
}

// Revalidate against the latest repository state at drop time, not just drag start.
export function groupDropPaths(state, drag, groupId, busy = false) {
  if (busy || !state?.root || drag?.root !== state.root || !Array.isArray(drag.paths) || !drag.paths.length) return [];
  const groups = changeGroups(state.files, state.changelists);
  const target = groups.find(group => group.id === groupId);
  if (!target) return [];
  const files = new Map(state.files.map(file => [file.path, file]));
  if (drag.paths.some(path => !files.has(path) || files.get(path).conflict)) return [];
  if (target.type === 'unversioned' && drag.paths.some(path => !canReturnToUnversioned(files.get(path)))) return [];
  const alreadyThere = new Set(target.files.map(file => file.path));
  return [...new Set(drag.paths)].filter(path => !alreadyThere.has(path));
}
