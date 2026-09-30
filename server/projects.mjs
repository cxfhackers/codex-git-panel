import { readFile, realpath } from 'node:fs/promises';
import { basename } from 'node:path';
import { createHash } from 'node:crypto';
import { git, repository } from './git.mjs';

export async function commonDirectory(root) {
  return realpath((await git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim());
}
export async function projectSession(cwd = process.cwd(), groups) {
  if (!groups) {
    const configured = process.env.GIT_PANEL_PROJECTS_FILE;
    const config = configured || new URL('./project-repositories.json', import.meta.url);
    try { groups = JSON.parse(await readFile(config, 'utf8')).groups; }
    catch (error) {
      if (configured || error.code !== 'ENOENT') throw error;
      groups = [];
    }
    if (!Array.isArray(groups)) throw new Error('项目仓库配置中的 groups 必须是数组');
  }
  let current;
  try { current = await repository(cwd); } catch {
    return { project: { label: basename(cwd), key: createHash('sha256').update(cwd).digest('hex'), cwd, defaultRoot: '' }, projects: [] };
  }
  const common = await commonDirectory(current);
  for (const group of groups) {
    const projects = [];
    for (const item of group.repositories) {
      try { const root = await repository(item.root); projects.push({ ...item, root, common: await commonDirectory(root) }); } catch {}
    }
    if (projects.some(p => p.common === common)) {
      if (!projects.some(p => p.root === current)) projects.push({ label: `${basename(current)} · worktree`, root: current, common });
      return { project: { label: group.label, key: createHash('sha256').update([...new Set(projects.map(p => p.common))].sort().join('\0')).digest('hex'), cwd, defaultRoot: current }, projects };
    }
  }
  return { project: { label: basename(current), key: createHash('sha256').update(common).digest('hex'), cwd, defaultRoot: current }, projects: [{ label: basename(current), root: current, common }] };
}
export async function scopedRepository(input, session) {
  const root = await repository(input);
  if (session.projects.length && !session.projects.some(p => p.root === root)) {
    const common = await commonDirectory(root);
    if (!session.projects.some(p => p.common === common)) throw new Error('此仓库不属于当前 Codex 项目；请从对应项目重新打开 Git 面板');
  }
  return root;
}
export const session = await projectSession();
export const projects = session.projects;
