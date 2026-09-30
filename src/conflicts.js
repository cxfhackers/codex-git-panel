// Git-generated diff3 markers are deliberately longer than ordinary worktree markers.
const marker = (character, label = '') => character.repeat(20) + (label ? ' ' + label : '');
export function conflictParts(text) {
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) || [], parts = [];
  let plain = '', block = null, side = '';
  for (const line of lines) {
    const value = line.replace(/\r?\n$/, '');
    if (value === marker('<', 'git-panel-left')) {
      if (block) throw new Error('无法解析冲突内容');
      if (plain) parts.push({ text: plain }); plain = '';
      block = { index: parts.filter(p => p.index !== undefined).length, left: '', base: '', right: '', raw: line }; side = 'left';
    } else if (block && value === marker('|', 'git-panel-base')) { block.raw += line; side = 'base'; }
    else if (block && value === marker('=')) { block.raw += line; side = 'right'; }
    else if (block && value === marker('>', 'git-panel-right')) { block.raw += line; parts.push(block); block = null; side = ''; }
    else if (block) { block.raw += line; block[side] += line; }
    else plain += line;
  }
  if (block) throw new Error('冲突内容不完整');
  if (plain) parts.push({ text: plain });
  return parts;
}
export function mergeChoices(parts, choices) {
  return parts.map(part => part.index === undefined ? part.text : choices[part.index] ?? part.raw).join('');
}
export function hasConflictMarkers(text) { return /^(?:<{7,}|>{7,}|\|{7,})(?:\s|$)/m.test(text); }
