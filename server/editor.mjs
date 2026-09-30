import { lstat, realpath, open, rename, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { validPath } from './exclusions.mjs';
const limit = 512 * 1024;
async function locate(root, path) {
  if (!validPath(path)) throw new Error('文件路径无效');
  const absolute = join(root, path);
  if (await realpath(dirname(absolute)) !== dirname(absolute)) throw new Error('不支持编辑符号链接目录中的文件');
  const info = await lstat(absolute);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('仅支持编辑普通文本文件，不支持链接或目录');
  if (info.size > limit) throw new Error('文件超过 512 KiB，请使用外部编辑器');
  return absolute;
}
export async function readEditable(root, path) {
  const absolute = await locate(root, path);
  const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > limit) throw new Error('文件类型或大小已变化，请重新打开');
    const buffer = Buffer.alloc(limit + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) { const read = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead); if (!read.bytesRead) break; bytesRead += read.bytesRead; }
    const bytes = buffer.subarray(0, bytesRead);
    if (bytesRead > limit || bytes.includes(0)) throw new Error('文件过大或为二进制，无法在面板编辑');
    let content; try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { throw new Error('仅支持 UTF-8 文本文件，请使用外部编辑器'); }
    const token = createHash('sha256').update(bytes).update(`${info.ino}:${info.mode}:${info.mtimeMs}:${info.ctimeMs}`).digest('hex');
    return { path, content, token, mode: info.mode & 0o777, crlf: /\r\n/.test(content) && !/(?<!\r)\n/.test(content) };
  } finally { await handle.close(); }
}
export async function saveEditable(root, body) {
  if (typeof body.content !== 'string' || body.content.includes('\0') || Buffer.byteLength(body.content) > limit) throw new Error('文本无效或超过 512 KiB');
  const before = await readEditable(root, body.path);
  if (before.token !== body.token) throw new Error('文件已被外部修改，请保留当前草稿，重新读取磁盘版本后再保存');
  const content = before.crlf ? body.content.replace(/\r?\n/g, '\r\n') : body.content;
  if (Buffer.byteLength(content) > limit) throw new Error('保存后的文本超过 512 KiB，请使用外部编辑器');
  const absolute = await locate(root, body.path), temporary = join(dirname(absolute), '.git-panel-edit-' + randomUUID());
  const handle = await open(temporary, 'wx', before.mode);
  try {
    await handle.writeFile(content, 'utf8'); await handle.chmod(before.mode); await handle.sync(); await handle.close();
    if ((await readEditable(root, body.path)).token !== body.token) throw new Error('保存前文件已被外部修改，草稿已保留');
    await rename(temporary, absolute);
    return await readEditable(root, body.path);
  } finally { await handle.close().catch(() => {}); await unlink(temporary).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
}
