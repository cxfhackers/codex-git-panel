import { readEditable } from './editor.mjs';
import { git, parseStatus } from './git.mjs';

// Compare with HEAD, rather than the index: the commit view selects whole local files.
// Resolve the tree entry first so filenames stay literal, including colons and newlines.
export async function readComparison(root, path) {
  const current = await readEditable(root, path);
  const [head, status] = await Promise.all([
    git(root, ['rev-parse', '--verify', 'HEAD']).catch(() => ''),
    // A path-limited status turns a rename into an addition because its old
    // endpoint is outside the pathspec. Tracked-only status preserves that pair
    // without traversing untracked directories.
    git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=no']),
  ]);
  const change = parseStatus(status).find(file => file.path === path);
  const originalPath = change?.oldPath || path;
  if (!head.trim()) return { ...current, original: '', originalPath };
  const tree = await git(root, ['ls-tree', '-z', head.trim(), '--', originalPath]);
  const entry = tree.split('\0').find(line => line.slice(line.indexOf('\t') + 1) === originalPath);
  if (!entry) return { ...current, original: '', originalPath };
  const match = entry.match(/^\d+ blob ([0-9a-f]+)\t/);
  if (!match) throw new Error('该文件类型不支持原位编辑');
  const length = Number((await git(root, ['cat-file', '-s', match[1]])).trim());
  if (length > 512 * 1024) throw new Error('基准版本超过 512 KiB，请使用外部编辑器');
  const bytes = await git(root, ['cat-file', 'blob', match[1]], { encoding: 'buffer', maxBuffer: 512 * 1024 + 1 });
  if (bytes.includes(0)) throw new Error('基准版本为二进制，请使用外部编辑器');
  let original;
  try { original = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new Error('基准版本不是 UTF-8 文本，请使用外部编辑器'); }
  return { ...current, original, originalPath };
}
