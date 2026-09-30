import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { git, snapshot } from '../server/git.mjs';
import { projectSession, scopedRepository } from '../server/projects.mjs';
import { generateMessage, collectStaged, model } from '../server/ai.mjs';
const scratch = new URL('../../../work/git-panel-qa/', import.meta.url).pathname;
async function fixture(t) { await mkdir(scratch, { recursive: true }); const base = await mkdtemp(join(scratch, 'project-ai-')); t.after(() => rm(base, { recursive: true, force: true })); for (const name of ['front', 'back', 'unrelated']) { const root = join(base, name); await mkdir(root); await git(root, ['init', '-b', 'main']); await git(root, ['config', 'user.name', 'QA']); await git(root, ['config', 'user.email', 'qa@example.invalid']); await git(root, ['config', 'core.hooksPath', '/dev/null']); await git(root, ['config', 'commit.gpgsign', 'false']); await writeFile(join(root, 'a.txt'), 'initial\n'); await git(root, ['add', '.']); await git(root, ['commit', '-m', 'initial']); } return base; }
test('current project scope includes frontend/backend only and allows their worktrees', async t => {
  const base = await fixture(t), front = join(base, 'front'), back = join(base, 'back'), groups = [{ label: 'Project', repositories: [{ label: 'front', root: front }, { label: 'back', root: back }] }];
  const s = await projectSession(back, groups), other = await projectSession(front, groups);
  assert.equal(s.project.key, other.project.key); assert.equal(s.project.defaultRoot, back); assert.deepEqual(s.projects.map(p => p.root), [front, back]);
  await assert.rejects(scopedRepository(join(base, 'unrelated'), s), /不属于/);
  const worktree = join(base, 'worktree'); await git(back, ['worktree', 'add', '-b', 'qa-worktree', worktree]);
  assert.equal(await scopedRepository(worktree, s), worktree); const ws = await projectSession(worktree, groups); assert.equal(ws.project.key, s.project.key);
});
test('AI excludes unstaged contents, rejects stale output and malformed model output', async t => {
  const base = await fixture(t), root = join(base, 'front'); await writeFile(join(root, 'a.txt'), 'selected\n'); await git(root, ['add', '.']); await writeFile(join(root, 'leave.txt'), 'do not analyze\n'); const before = await snapshot(root);
  const data = await collectStaged(root, before); assert.match(data.patch, /selected/); assert.doesNotMatch(data.patch, /do not analyze/);
  await assert.rejects(generateMessage(root, before, async () => ({ title: '', body: '' })), /格式/);
  await assert.rejects(generateMessage(root, before, async () => { await writeFile(join(root, 'a.txt'), 'new change\n'); return { title: 'fix: example', body: '' }; }), /已变化/);
});
test('commit message uses the faster model while conflict analysis keeps the configured model', async () => {
  const previousCommit = process.env.GIT_PANEL_COMMIT_AI_MODEL;
  const previousGeneral = process.env.GIT_PANEL_AI_MODEL;
  try {
    delete process.env.GIT_PANEL_COMMIT_AI_MODEL;
    delete process.env.GIT_PANEL_AI_MODEL;
    assert.equal(await model('commit'), 'gpt-6-luna');
    process.env.GIT_PANEL_AI_MODEL = 'general-override';
    assert.equal(await model('commit'), 'general-override');
    assert.equal(await model('general'), 'general-override');
    process.env.GIT_PANEL_COMMIT_AI_MODEL = 'commit-override';
    assert.equal(await model('commit'), 'commit-override');
    assert.equal(await model('general'), 'general-override');
  } finally {
    if (previousCommit === undefined) delete process.env.GIT_PANEL_COMMIT_AI_MODEL;
    else process.env.GIT_PANEL_COMMIT_AI_MODEL = previousCommit;
    if (previousGeneral === undefined) delete process.env.GIT_PANEL_AI_MODEL;
    else process.env.GIT_PANEL_AI_MODEL = previousGeneral;
  }
});
