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
