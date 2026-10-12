// Run: node --test pr-review-handoff/hook.test.mjs
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  CODER_RULE, commandDir, createResult, eventDir, findBuilderPane, findReviewerPane, fixPrompt, headBranch, heredocsOpened,
  isPrCreate, isReviewRequest, localFixPrompt, localReviewPrompt, recentStarts, repoOf, reviewPrompt, sameBranch,
  sessionOutput, withoutHeredocs,
} from './hook.mjs';

const HOOK = fileURLToPath(new URL('./hook.mjs', import.meta.url));
const FAKE_HERDR = fileURLToPath(new URL('../test/fake-herdr.cjs', import.meta.url));
const URL_ = 'https://github.com/example/repro/pull/1';

// A coder pane running codex and a reviewer pane running claude, in workspace wV.
const PANES = () => [
  { pane_id: 'wV:p1', workspace_id: 'wV', tab_id: 'wV:t1', label: 'coder', agent: 'codex', agent_session: { kind: 'id', value: 'builder-session' }, cwd: '/repo' },
  { pane_id: 'wV:p2', workspace_id: 'wV', tab_id: 'wV:t1', label: 'reviewer', agent: 'claude', cwd: '/repo' },
];

// Runs the worker against a fake herdr and a fake gh. Returns the log, and the herdr calls.
function workerFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'prh-worker-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'bin');
  const state = join(dir, 'state');
  const findings = join(dir, 'findings');
  mkdirSync(bin);
  mkdirSync(state);
  const herdrState = join(dir, 'herdr.json');
  const apiFile = join(dir, 'api');
  writeFileSync(join(bin, 'gh'), `#!${process.execPath}\nconst fs=require('node:fs');
const args=process.argv.slice(2);
if(args[0]==='pr') console.log(JSON.stringify({url:${JSON.stringify(URL_)},number:1,state:'OPEN',createdAt:new Date().toISOString(),headRefName:'feat/repro'}));
else { const n=fs.existsSync(${JSON.stringify(apiFile)})?Number(fs.readFileSync(${JSON.stringify(apiFile)},'utf8')):0; fs.writeFileSync(${JSON.stringify(apiFile)},String(n+1)); console.log(JSON.stringify(n?[{submitted_at:'2026-01-01',html_url:${JSON.stringify(URL_ + '#pullrequestreview-1')}}]:[])); }
`, { mode: 0o755 });
  const herdr = () => JSON.parse(readFileSync(herdrState, 'utf8'));
  return {
    dir,
    state,
    findings,
    calls: () => herdr().calls,
    panes: () => herdr().panes,
    prompts: (pane) => herdr().calls.filter((a) => a[0] === 'agent' && a[1] === 'prompt' && (!pane || a[2] === pane)).map((a) => a[3]),
    notified: (text) => herdr().calls.some((a) => a[0] === 'notification' && a.some((x) => x.includes(text))),
    claimed: () => existsSync(join(state, 'handed-off')) && readdirSync(join(state, 'handed-off')).length > 0,
    starts: () => existsSync(join(state, 'review-starts')) ? readdirSync(join(state, 'review-starts')).flatMap((f) => JSON.parse(readFileSync(join(state, 'review-starts', f), 'utf8'))) : [],
    // kind 'pr' runs the gh pr create worker; 'local' runs the herdr-review worker.
    run(mode, { tool = 'codex', panes = PANES(), current = 'wV:p1', kind = 'pr', event = {}, keepHerdr = false } = {}) {
      if (!keepHerdr || !existsSync(herdrState)) writeFileSync(herdrState, JSON.stringify({ mode, current, panes, next: 3, calls: [] }));
      else writeFileSync(herdrState, JSON.stringify({ ...herdr(), mode }));
      rmSync(apiFile, { force: true });
      const eventFile = join(dir, 'event.json');
      const base = kind === 'pr'
        ? { cwd: dir, session_id: 'builder-session', tool_name: 'Bash', tool_input: { command: 'gh pr create --head feat/repro' }, tool_response: URL_ }
        : { cwd: dir, session_id: 'builder-session', tool_name: 'Bash', tool_input: { command: 'herdr-review' }, tool_response: 'Review requested.' };
      writeFileSync(eventFile, JSON.stringify({ ...base, ...event }));
      const run = spawnSync(process.execPath, [HOOK, tool, `--${kind}-worker`, eventFile], {
        env: {
          ...process.env, HERDR_ENV: '1', HERDR_SOCKET_PATH: '/test.sock', HERDR_PANE_ID: current, HERDR_WORKSPACE_ID: current.split(':')[0],
          PR_REVIEWER: '', PR_REVIEW_MAX_PER_HOUR: '', PR_HANDOFF_STATE_DIR: state, PR_HANDOFF_FINDINGS_DIR: findings,
          HERDR_BIN_PATH: FAKE_HERDR, FAKE_HERDR_STATE: herdrState, PATH: `${bin}:${process.env.PATH}`,
        },
        encoding: 'utf8', timeout: 40000,
      });
      assert.equal(run.status, 0, run.stderr || run.error?.message);
      return existsSync(join(state, 'log')) ? readFileSync(join(state, 'log'), 'utf8') : '';
    },
  };
}

test('a PR goes to the reviewer pane, and the fix prompt back to the coder', t => {
  const fixture = workerFixture(t);
  const log = fixture.run('ok');
  assert.match(log, /built by codex in wV:p1/);
  assert.match(log, /review by claude in wV:p2/);
  assert.match(log, /review done: .*pullrequestreview-1/);
  assert.ok(fixture.prompts('wV:p2').some((p) => p.startsWith('Review pull request')));
  assert.ok(fixture.prompts('wV:p1').some((p) => p.startsWith('claude reviewed your pull request')));
  // A reviewer with an agent already running starts from a clean context.
  assert.ok(fixture.prompts('wV:p2').includes('/clear'));
  assert.equal(fixture.notified('not independent'), false);
});

test('the coder tool comes from Herdr, not from the hook argument', t => {
  // Cursor runs Claude Code's hooks, so the argument can say claude while codex runs in the pane.
  const fixture = workerFixture(t);
  assert.match(fixture.run('ok', { tool: 'claude' }), /built by codex in wV:p1/);
});

test('a stale caller pane falls back to the pane with the same agent session', t => {
  const fixture = workerFixture(t);
  const log = fixture.run('missing');
  assert.match(log, /built by codex in wV:p1/);
  assert.match(log, /review done:/);
});

test('without a session match, the pane labelled coder is the coder', t => {
  const fixture = workerFixture(t);
  const log = fixture.run('missing', { event: { session_id: undefined } });
  assert.match(log, /built by codex in wV:p1/);
});

test('a moved coder uses the pane and workspace resolved by Herdr', t => {
  const fixture = workerFixture(t);
  const panes = PANES().map((p) => ({ ...p, pane_id: p.pane_id.replace('wV', 'wN'), workspace_id: 'wN', tab_id: 'wN:t1' }));
  panes[0].pane_id = 'wN:p9';
  const log = fixture.run('ok', { panes, current: 'wN:p9' });
  assert.match(log, /review by claude in wN:p2/);
  assert.ok(fixture.prompts('wN:p9').length > 0);
});

test('a review request from the reviewer pane is skipped', t => {
  const fixture = workerFixture(t);
  const log = fixture.run('ok', { current: 'wV:p2', event: { session_id: undefined } });
  assert.match(log, /the request came from reviewer pane wV:p2/);
  assert.ok(fixture.notified('PR from the reviewer pane'));
  assert.equal(fixture.claimed(), false);
  assert.equal(fixture.prompts().length, 0);
});

test('herdr-review from the reviewer pane is skipped without a notice', t => {
  const fixture = workerFixture(t);
  const repo = gitRepo(fixture.dir);
  const log = fixture.run('ok', { kind: 'local', current: 'wV:p2', event: { cwd: repo, session_id: undefined } });
  assert.match(log, /the request came from reviewer pane wV:p2/);
  assert.equal(fixture.notified('reviewer pane'), false);
  assert.equal(fixture.prompts().length, 0);
});

test('the same tool in both panes still reviews, with a notice', t => {
  const fixture = workerFixture(t);
  const panes = PANES();
  panes[1].agent = 'codex';
  assert.match(fixture.run('ok', { panes }), /review done:/);
  assert.ok(fixture.notified('not independent'));
  assert.ok(fixture.prompts('wV:p2').includes('/new'));
});

test('a workspace without a reviewer pane gets one, with the other tool', t => {
  const fixture = workerFixture(t);
  const log = fixture.run('ok', { panes: PANES().slice(0, 1) });
  assert.match(log, /review by claude in wV:p3/);
  const split = fixture.calls().find((a) => a[0] === 'pane' && a[1] === 'split');
  assert.deepEqual(split.slice(split.indexOf('--pane'), split.indexOf('--pane') + 2), ['--pane', 'wV:p1']);
  assert.equal(fixture.panes().find((p) => p.pane_id === 'wV:p3').label, 'reviewer');
  // A new reviewer has an empty context already.
  assert.ok(!fixture.prompts('wV:p3').includes('/clear'));
});

test('an empty reviewer pane gets a tool before the review', t => {
  const fixture = workerFixture(t);
  const panes = PANES();
  delete panes[1].agent;
  assert.match(fixture.run('ok', { panes }), /review by claude in wV:p2/);
  assert.ok(fixture.calls().some((a) => a[0] === 'agent' && a[1] === 'start' && a.includes('claude') && a.includes('wV:p2')));
});

test('a layout failure releases the reservation and reports the error', t => {
  const fixture = workerFixture(t);
  assert.match(fixture.run('layout-failed'), /pane_not_found/);
  assert.equal(fixture.claimed(), false);
  assert.equal(fixture.starts().length, 0);
  assert.ok(fixture.notified('Review handoff failed'));
  assert.equal(fixture.prompts().length, 0);
});

test('failed reviewer startup releases the PR and hourly slot for a successful retry', t => {
  const fixture = workerFixture(t);
  fixture.run('startup-failed');
  assert.equal(fixture.claimed(), false);
  assert.equal(fixture.starts().length, 0);
  assert.ok(fixture.notified('Review handoff failed'));
  const log = fixture.run('ok');
  assert.equal(fixture.claimed(), true);
  assert.equal(fixture.starts().length, 1);
  assert.match(log, /review done:/);
});

test('a release that returns false is logged as kept', t => {
  const fixture = workerFixture(t);
  const log = fixture.run('release-false');
  assert.match(log, /startup failed; kept review reservation/);
  assert.doesNotMatch(log, /released review reservation/);
  assert.match(log, /error: Error: herdr agent get: agent_not_found/);
  assert.equal(fixture.claimed(), true);
});

test('a release error does not replace the original startup error', t => {
  const fixture = workerFixture(t);
  const log = fixture.run('release-throws');
  assert.match(log, /release failed:.*EISDIR/);
  assert.match(log, /startup failed; kept review reservation/);
  assert.match(log, /error: Error: herdr agent get: agent_not_found/);
  assert.equal(fixture.claimed(), true);
});

test('uncertain prompt delivery keeps duplicate protection', t => {
  const fixture = workerFixture(t);
  fixture.run('delivery-unknown');
  assert.equal(fixture.claimed(), true);
  assert.equal(fixture.starts().length, 1);
  const log = fixture.run('ok');
  assert.match(log, /already handed off/);
  assert.equal(fixture.prompts().filter((p) => p.startsWith('Review pull request')).length, 0);
});

// A git repository with one commit and one uncommitted change.
function gitRepo(dir) {
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' });
  git('init', '-q');
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  git('add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'first');
  writeFileSync(join(repo, 'a.txt'), 'two\n');
  return repo;
}

test('herdr-review sends the local diff to the reviewer, and the findings file back to the coder', t => {
  const fixture = workerFixture(t);
  const repo = gitRepo(fixture.dir);
  const log = fixture.run('ok', { kind: 'local', event: { cwd: repo } });
  assert.match(log, /review by claude in wV:p2/);
  const review = fixture.prompts('wV:p2').find((p) => p.startsWith('Review the local changes'));
  // No remote, so the base is HEAD: the review covers the uncommitted change. Git gives the real path.
  assert.ok(review.includes(`git -C ${realpathSync(repo)} diff HEAD`), review);
  const [file] = readdirSync(fixture.findings);
  assert.equal(readFileSync(join(fixture.findings, file), 'utf8'), 'No findings.\n');
  const fix = fixture.prompts('wV:p1').find((p) => p.startsWith('claude reviewed your local changes'));
  assert.ok(fix.includes(join(fixture.findings, file)));
  assert.match(fix, /Do not run herdr-review for these fixes/);
});

test('herdr-review with no changes, or outside git, does nothing', t => {
  const fixture = workerFixture(t);
  const repo = gitRepo(fixture.dir);
  execFileSync('git', ['-C', repo, 'checkout', '--', '.']);
  assert.match(fixture.run('ok', { kind: 'local', event: { cwd: repo } }), /skip herdr-review in .*: no changes/);
  assert.match(fixture.run('ok', { kind: 'local', event: { cwd: fixture.findings.replace('findings', 'bin') } }), /not a git repository/);
  assert.equal(fixture.prompts().length, 0);
});

test('a reviewer that writes no findings file is asked 3 times, then reported', t => {
  const fixture = workerFixture(t);
  const repo = gitRepo(fixture.dir);
  assert.match(fixture.run('no-findings-file', { kind: 'local', event: { cwd: repo } }), /wrote no review/);
  assert.equal(fixture.prompts('wV:p2').filter((p) => p.startsWith('Review the local changes')).length, 3);
  assert.ok(fixture.notified('No review'));
  assert.equal(fixture.prompts('wV:p1').length, 0);
});

test('a review prompt the reviewer dropped is sent again', t => {
  const fixture = workerFixture(t);
  const repo = gitRepo(fixture.dir);
  const log = fixture.run('drop-first', { kind: 'local', event: { cwd: repo } });
  assert.match(log, /ready again at once with no review; sending the prompt again/);
  assert.match(log, /review done:/);
  assert.equal(fixture.prompts('wV:p2').filter((p) => p.startsWith('Review the local changes')).length, 2);
  assert.ok(fixture.prompts('wV:p1').some((p) => p.startsWith('claude reviewed your local changes')));
});

test('a reviewer that looks idle for a moment mid-review is not cut short', t => {
  const fixture = workerFixture(t);
  const repo = gitRepo(fixture.dir);
  const log = fixture.run('flicker', { kind: 'local', event: { cwd: repo } });
  assert.match(log, /review done:/);
  assert.doesNotMatch(log, /sending the prompt again/);
  assert.equal(fixture.prompts('wV:p2').filter((p) => p.startsWith('Review the local changes')).length, 1);
});

test('a PR made after cd names that checkout in the review prompt', t => {
  const fixture = workerFixture(t);
  const repo = gitRepo(fixture.dir);
  fixture.run('ok', { event: { tool_input: { command: 'cd repo && gh pr create --head feat/repro' } } });
  const review = fixture.prompts('wV:p2').find((p) => p.startsWith('Review pull request'));
  assert.match(review, new RegExp(`checked out in ${realpathSync(repo)}\\.`));
  assert.match(review, new RegExp(`Work in ${realpathSync(repo)}: run every command there`));
});

test('a changed untracked file gets a new review', t => {
  const fixture = workerFixture(t);
  const repo = gitRepo(fixture.dir);
  execFileSync('git', ['-C', repo, 'checkout', '--', '.']);
  writeFileSync(join(repo, 'new.js'), 'export const a = 1;\n');
  assert.match(fixture.run('ok', { kind: 'local', event: { cwd: repo } }), /review done:/);
  writeFileSync(join(repo, 'new.js'), 'export const a = 2;\n');
  const log = fixture.run('ok', { kind: 'local', event: { cwd: repo } });
  assert.doesNotMatch(log.split('\n').slice(-6).join('\n'), /already handed off/);
  assert.equal(fixture.prompts('wV:p2').filter((p) => p.startsWith('Review the local changes')).length, 1);
});

test('a large local diff is still reviewed', t => {
  const fixture = workerFixture(t);
  const repo = gitRepo(fixture.dir);
  // About 2 MB of diff: more than the 1 MB that execFileSync buffers by default.
  writeFileSync(join(repo, 'a.txt'), Array.from({ length: 60000 }, (_, i) => `line ${i} of a large change`).join('\n'));
  const log = fixture.run('ok', { kind: 'local', event: { cwd: repo } });
  assert.match(log, /review done:/);
  assert.doesNotMatch(log, /not a git repository|ENOBUFS/);
});

test('a git failure is reported as an error, not as "no changes" or "not a git repository"', t => {
  const fixture = workerFixture(t);
  const repo = gitRepo(fixture.dir);
  const index = join(repo, '.git', 'index');
  chmodSync(index, 0o000);
  let log;
  try { log = fixture.run('ok', { kind: 'local', event: { cwd: repo } }); } finally { chmodSync(index, 0o644); }
  assert.match(log, /error: Error: git diff failed in /);
  assert.doesNotMatch(log, /not a git repository|no changes/);
  assert.ok(fixture.notified('Review handoff failed'));
});

test('the same local diff is reviewed once', t => {
  const fixture = workerFixture(t);
  const repo = gitRepo(fixture.dir);
  fixture.run('ok', { kind: 'local', event: { cwd: repo } });
  assert.match(fixture.run('ok', { kind: 'local', event: { cwd: repo } }), /already handed off/);
});

// Runs the session hook with a fake herdr where the caller pane has the given label.
function runSession(t, tool, label, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'prh-session-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const herdrState = join(dir, 'herdr.json');
  writeFileSync(herdrState, JSON.stringify({ mode: 'ok', current: 'wV:p1', panes: [{ pane_id: 'wV:p1', workspace_id: 'wV', label }], next: 2, calls: [] }));
  return spawnSync(process.execPath, [HOOK, tool, 'session'], {
    input: '{}', encoding: 'utf8', timeout: 10000,
    env: { ...process.env, HERDR_ENV: '1', HERDR_BIN_PATH: FAKE_HERDR, FAKE_HERDR_STATE: herdrState, PR_HANDOFF_STATE_DIR: dir, ...env },
  }).stdout;
}

test('the session hook gives the coder the rule, in the format of each tool', t => {
  const claude = JSON.parse(runSession(t, 'claude', 'coder'));
  assert.equal(claude.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.equal(claude.hookSpecificOutput.additionalContext, CODER_RULE);
  assert.equal(runSession(t, 'kiro', null), `${CODER_RULE}\n`);
  // Never in the reviewer pane, and never outside Herdr.
  assert.equal(runSession(t, 'claude', 'reviewer'), '');
  assert.equal(runSession(t, 'claude', 'coder', { HERDR_ENV: '' }), '');
});

test('sessionOutput and CODER_RULE stay one line each', () => {
  assert.doesNotMatch(CODER_RULE, /\n/);
  assert.match(CODER_RULE, /herdr-review/);
  assert.equal(JSON.parse(sessionOutput('codex')).hookSpecificOutput.additionalContext, CODER_RULE);
});

test('findBuilderPane prefers the agent session, then the caller, then the coder label', () => {
  const coder = { pane_id: 'w1:p1', workspace_id: 'w1', label: 'coder', agent: 'claude', agent_session: { value: 's1' } };
  const other = { pane_id: 'w1:p3', workspace_id: 'w1', agent: 'kiro' };
  const panes = [coder, other];
  assert.equal(findBuilderPane(panes, { current: other, sessionId: 's1', workspace: 'w1' }), coder);
  assert.equal(findBuilderPane(panes, { current: other, sessionId: 'none', workspace: 'w1' }), other);
  assert.equal(findBuilderPane(panes, { current: null, sessionId: undefined, workspace: 'w1' }), coder);
  assert.equal(findBuilderPane(panes, { current: null, sessionId: undefined, workspace: 'w2' }), null);
});

test('findReviewerPane finds the reviewer in the coder workspace, same tab first', () => {
  const coder = { pane_id: 'w1:p1', workspace_id: 'w1', tab_id: 'w1:t1', label: 'coder' };
  const far = { pane_id: 'w1:p5', workspace_id: 'w1', tab_id: 'w1:t2', label: 'reviewer' };
  const near = { pane_id: 'w1:p2', workspace_id: 'w1', tab_id: 'w1:t1', label: 'codex review' };
  const elsewhere = { pane_id: 'w2:p2', workspace_id: 'w2', tab_id: 'w2:t1', label: 'reviewer' };
  assert.equal(findReviewerPane([coder, far, near, elsewhere], coder), near);
  assert.equal(findReviewerPane([coder, far], coder), far);
  assert.equal(findReviewerPane([coder, elsewhere], coder), null);
});

test('isReviewRequest matches herdr-review where a command starts', () => {
  assert.equal(isReviewRequest({ tool_name: 'Bash', tool_input: { command: 'herdr-review' } }), true);
  assert.equal(isReviewRequest({ tool_name: 'shell', tool_input: { command: 'cd app && herdr-review' } }), true);
  assert.equal(isReviewRequest({ tool_name: 'Shell', tool_input: { command: 'echo "run herdr-review later"' } }), false);
  assert.equal(isReviewRequest({ tool_name: 'Write', tool_input: { command: 'herdr-review' } }), false);
  assert.equal(commandDir('cd app && herdr-review', '/repo', /(?:^|[;&|(]|\n)\s*herdr-review\b/), '/repo/app');
});

test('Kiro and Cursor events count: tool names and output fields', () => {
  assert.equal(isPrCreate({ tool_name: 'shell', tool_input: { command: 'gh pr create --fill' } }), true);
  assert.equal(createResult({ tool_output: '{"output":"https://github.com/o/r/pull/5\\n","exitCode":0}' }).url, 'https://github.com/o/r/pull/5');
  assert.equal(createResult({ tool_response: { items: [{ Json: { stdout: 'https://github.com/o/r/pull/6\n' } }] } }).url, 'https://github.com/o/r/pull/6');
  // Cursor sends an empty cwd.
  assert.equal(eventDir({ cwd: '', workspace_roots: ['/ws'] }), '/ws');
  assert.equal(eventDir({ cwd: '', tool_input: { cwd: '/sub' }, workspace_roots: ['/ws'] }), '/sub');
  assert.equal(eventDir({ cwd: '/x' }), '/x');
});

test('the local review prompts name the repository, the base and the findings file', () => {
  const local = { root: '/repo', base: 'abc123', file: '/tmp/herdr-review/1-x.md' };
  const review = localReviewPrompt(local);
  assert.match(review, /git -C \/repo diff abc123/);
  assert.match(review, /Do not edit/);
  assert.match(review, /The only file you write is \/tmp\/herdr-review\/1-x\.md/);
  assert.doesNotMatch(review, /\n/);
  const fix = localFixPrompt(local, 'codex');
  assert.match(fix, /^codex reviewed your local changes in \/repo/);
  assert.doesNotMatch(fix, /\n/);
});

const bash = (command) => ({ tool_name: 'Bash', tool_input: { command } });

test('isPrCreate matches gh pr create only', () => {
  assert.equal(isPrCreate(bash('gh pr create --draft --title "x" --body "y"')), true);
  assert.equal(isPrCreate(bash('git push -u origin feat && gh pr create --fill')), true);
  assert.equal(isPrCreate({ tool_name: 'Shell', tool_input: { command: 'gh pr create' } }), true);
  assert.equal(isPrCreate(bash('gh pr edit 4 --title x')), false);
  assert.equal(isPrCreate(bash('cd repo && gh pr create --fill')), true);
  assert.equal(isPrCreate(bash('git push\ngh pr create --fill')), true);
  assert.equal(isPrCreate(bash('gh pr view 4')), false);
  assert.equal(isPrCreate(bash('echo "then run gh pr create" > notes.md')), false);
  assert.equal(isPrCreate(bash("python3 - <<'PY'\n# After an agent runs \"gh pr create\" here\nPY")), false);
  // Inside a heredoc, even text that looks like a command chain is only text.
  assert.equal(isPrCreate(bash("python3 - <<'PY'\nnote = 'gh pr view 3 && gh pr create'\nPY")), false);
  assert.equal(isPrCreate(bash("cat > a.md <<EOF\nrun:\ngh pr create --fill\nEOF\ngit add a.md")), false);
  // A real create next to a heredoc still counts, and so does a body passed with a heredoc.
  assert.equal(isPrCreate(bash("cat > b.md <<'EOF'\ntext\nEOF\ngh pr create --body-file b.md")), true);
  assert.equal(isPrCreate(bash("gh pr create --title T --body-file - <<'EOF'\nBody && gh pr view 2\nEOF")), true);
  // One line can open two heredocs: both bodies are text.
  assert.equal(isPrCreate(bash('cat <<A <<B\nfirst\nA\n&& gh pr create\nB')), false);
  assert.equal(isPrCreate(bash("cat <<-'X'\n\tgh pr create\n\tX\necho done")), false);
  // A here-string is not a heredoc, so the command after it still counts.
  assert.equal(isPrCreate(bash('cat <<<"hello" && gh pr create --fill')), true);
  assert.equal(isPrCreate({ tool_name: 'Write', tool_input: { command: 'gh pr create' } }), false);
  assert.equal(isPrCreate({}), false);
});

test('commandDir follows a leading cd', () => {
  assert.equal(commandDir('gh pr create', '/repo'), '/repo');
  assert.equal(commandDir('cd sub && gh pr create', '/repo'), '/repo/sub');
  assert.equal(commandDir('cd "/other place" && gh pr create', '/repo'), '/other place');
  assert.equal(commandDir('cd ~/code && gh pr create', '/repo'), `${homedir()}/code`);
  // A cd after the PR command does not change where the PR was made.
  assert.equal(commandDir('cd a && gh pr create --fill && cd ../other', '/repo'), '/repo/a');
  // Each cd starts from the one before it.
  assert.equal(commandDir('cd service && cd app && gh pr create', '/repo'), '/repo/service/app');
  assert.equal(commandDir('cd service && cd /abs && cd app && gh pr create', '/repo'), '/abs/app');
});

test('createResult reads the new PR URL, and sees a create that failed', () => {
  const ok = createResult({ tool_response: { stdout: 'https://github.com/o/r/pull/9\n', stderr: '' } });
  assert.deepEqual(ok, { failed: false, url: 'https://github.com/o/r/pull/9' });
  const exists = createResult({ tool_response: { stderr: 'a pull request for branch "x" into branch "main" already exists:\nhttps://github.com/o/r/pull/4' } });
  assert.equal(exists.failed, true);
  assert.equal(createResult({ tool_response: 'https://github.com/o/r/pull/12' }).url, 'https://github.com/o/r/pull/12');
  assert.deepEqual(createResult({}), { failed: false, url: null });
  // Another PR's URL in the same output: ambiguous, so no URL is trusted.
  const two = createResult({ tool_response: { stdout: 'title: Old\nurl: https://github.com/o/r/pull/3\nhttps://github.com/o/r/pull/9\n' } });
  assert.equal(two.url, null);
  // The same URL twice is still one PR.
  assert.equal(createResult({ tool_response: 'https://github.com/o/r/pull/9 https://github.com/o/r/pull/9' }).url, 'https://github.com/o/r/pull/9');
});

test('sameBranch checks the PR is on the branch the command made it for', () => {
  assert.equal(sameBranch('feat/x', 'feat/x'), true);
  assert.equal(sameBranch('octo:feat/x', 'feat/x'), true);
  assert.equal(sameBranch('feat/x', 'main'), false);
  // Unknown branch (not a git folder): nothing to compare.
  assert.equal(sameBranch(null, 'feat/x'), true);
});

test('repoOf gives owner/repo', () => {
  assert.equal(repoOf('https://github.com/octo/demo/pull/14'), 'octo/demo');
  assert.notEqual(repoOf('https://github.com/o/a/pull/1'), repoOf('https://github.com/o/b/pull/1'));
});

test('headBranch reads --head and -H', () => {
  assert.equal(headBranch('gh pr create --fill'), null);
  assert.equal(headBranch('gh pr create --head feat/x --fill'), 'feat/x');
  assert.equal(headBranch('gh pr create --head=feat/x'), 'feat/x');
  assert.equal(headBranch('gh pr create -H "feat/y" --fill'), 'feat/y');
});

test('reviewPrompt names the PR and its checkout, and forbids edits', () => {
  const text = reviewPrompt({ url: 'https://github.com/o/r/pull/7', number: 7 }, '/work/r');
  assert.match(text, /checked out in \/work\/r\./);
  assert.match(text, /Work in \/work\/r: run every command there, and first read the AGENTS\.md/);
  assert.match(text, /do not run herdr-review/);
  assert.match(text, /pull\/7/);
  assert.match(text, /gh pr diff https:\/\/github.com\/o\/r\/pull\/7/);
  assert.match(text, /gh pr review https:\/\/github.com\/o\/r\/pull\/7 --comment/);
  assert.match(text, /Do not edit/);
  assert.doesNotMatch(text, /\n/);
});

test('fixPrompt asks the coder to fix, push and reply with each finding', () => {
  const text = fixPrompt({ url: 'https://github.com/o/r/pull/7', number: 7 }, 'https://github.com/o/r/pull/7#pullrequestreview-1', 'codex');
  assert.match(text, /^codex reviewed your pull request https:\/\/github.com\/o\/r\/pull\/7/);
  assert.match(text, /pullrequestreview-1/);
  assert.match(text, /gh pr comment https:\/\/github.com\/o\/r\/pull\/7 --body-file/);
  assert.match(text, /not fixed" with the reason/);
  assert.doesNotMatch(text, /\n/);
});

test('recentStarts keeps only the last hour', () => {
  const now = 10 * 3_600_000;
  assert.deepEqual(recentStarts([now - 3_700_000, now - 1_000, now - 60_000], now), [now - 1_000, now - 60_000]);
  assert.deepEqual(recentStarts(undefined, now), []);
  assert.deepEqual(recentStarts([now - 1000, { at: now - 2000, token: 'new' }, { at: now - 3700000, token: 'old' }], now), [now - 1000, { at: now - 2000, token: 'new' }]);
});

test('a reservation can only be released by its owner', t => {
  const state = mkdtempSync(join(tmpdir(), 'prh-release-'));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  const hook = new URL('./hook.mjs', import.meta.url).href;
  const code = `const m=await import(${JSON.stringify(hook)});
const results=[];
results.push(await m.takeReviewSlot('/s.sock|wV:p1','https://github.com/o/r/pull/1',3,0,'owner'));
results.push(await m.releaseReviewSlot('/s.sock|wV:p1','https://github.com/o/r/pull/1','other'));
results.push(await m.takeReviewSlot('/s.sock|wV:p1','https://github.com/o/r/pull/1',3,0,'retry'));
results.push(await m.releaseReviewSlot('/s.sock|wV:p1','https://github.com/o/r/pull/1','owner'));
results.push(await m.takeReviewSlot('/s.sock|wV:p1','https://github.com/o/r/pull/1',3,0,'retry'));
process.stdout.write(JSON.stringify(results));`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, PR_HANDOFF_STATE_DIR: state }, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), ['ok', false, 'duplicate', true, 'ok']);
  const [file] = readdirSync(join(state, 'review-starts'));
  assert.equal(JSON.parse(readFileSync(join(state, 'review-starts', file), 'utf8')).length, 1);
});

test('takeReviewSlot keeps the hourly limit when workers run at the same time', async () => {
  const state = mkdtempSync(join(tmpdir(), 'prh-slot-'));
  const hook = new URL('./hook.mjs', import.meta.url).href;
  // 6 workers for 6 different PRs from one builder pane start together; the limit is 3.
  const run = (n) => new Promise((done) => {
    const code = `import(${JSON.stringify(hook)}).then(async (m) => process.stdout.write(await m.takeReviewSlot('/s.sock|wV:p1', 'https://github.com/o/r/pull/${n}', 3, 300)))`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, PR_HANDOFF_STATE_DIR: state } });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', () => done(out));
  });
  const results = await Promise.all([1, 2, 3, 4, 5, 6].map(run));
  assert.equal(results.filter((r) => r === 'ok').length, 3);
  assert.equal(results.filter((r) => r === 'paused').length, 3);
  // All 3 start times are kept: no write wiped another.
  const [file] = readdirSync(join(state, 'review-starts'));
  assert.equal(JSON.parse(readFileSync(join(state, 'review-starts', file), 'utf8')).length, 3);
});

test('withoutHeredocs keeps the command lines and drops each body', () => {
  assert.equal(withoutHeredocs("cat <<A <<'B'\none\nA\ntwo\nB\ngh pr create"), "cat <<A <<'B'\ngh pr create");
  assert.equal(withoutHeredocs('git push && gh pr create --fill'), 'git push && gh pr create --fill');
});

test('heredocsOpened reads full delimiter words and skips what is not a heredoc', () => {
  assert.deepEqual(heredocsOpened("cat <<'EOF'"), [{ word: 'EOF', tabs: false }]);
  assert.deepEqual(heredocsOpened('cat <<END-OF'), [{ word: 'END-OF', tabs: false }]);
  assert.deepEqual(heredocsOpened('cat <<-"A B" <<\\C'), [{ word: 'A B', tabs: true }, { word: 'C', tabs: false }]);
  assert.deepEqual(heredocsOpened('gh pr create --body "$(cat <<\'EOF\'"'), [{ word: 'EOF', tabs: false }]);
  // Not heredocs: a shift in arithmetic, text in quotes, a here-string.
  assert.deepEqual(heredocsOpened('echo $((1 << 2)) && (( x <<= 1 ))'), []);
  assert.deepEqual(heredocsOpened('echo "a << b" \'c << d\''), []);
  assert.deepEqual(heredocsOpened('cat <<<"hello"'), []);
  // $'EOF' is the word EOF, and a backtick substitution in double quotes can open a heredoc.
  assert.deepEqual(heredocsOpened("cat <<$'EOF'"), [{ word: 'EOF', tabs: false }]);
  assert.deepEqual(heredocsOpened('echo "`cat <<EOF'), [{ word: 'EOF', tabs: false }]);
  assert.deepEqual(heredocsOpened('x=`cat <<END`'), [{ word: 'END', tabs: false }]);
});

test('withoutHeredocs ends a body only at its exact closing line', () => {
  const bash = (command) => isPrCreate({ tool_name: 'Bash', tool_input: { command } });
  // A shift or a quoted "<<" does not hide the real command after it.
  assert.equal(bash('echo $((1 << 2))\ngh pr create --fill'), true);
  assert.equal(bash('echo "x << y"\ngh pr create --fill'), true);
  // A delimiter with punctuation is read in full.
  assert.equal(bash('cat <<END-OF\n&& gh pr create\nEND-OF'), false);
  assert.equal(bash('cat <<END-OF\nbody\nEND-OF\ngh pr create'), true);
  // For "<<", a line with a space before EOF does not end the body.
  assert.equal(bash('cat <<EOF\n EOF\n&& gh pr create\nEOF'), false);
  // For "<<-", leading tabs (only tabs) are stripped from the closing line.
  assert.equal(bash('cat <<-EOF\n\tbody\n\tEOF\ngh pr create'), true);
  assert.equal(bash('cat <<-EOF\n  EOF\n&& gh pr create\nEOF'), false);
  // The command after a $'EOF' heredoc still counts; text in a backtick heredoc does not.
  assert.equal(bash("cat <<$'EOF'\nbody\nEOF\ngh pr create --fill"), true);
  assert.equal(bash('echo "`cat <<EOF\ngh pr create\nEOF\n`"'), false);
  // The usual way to pass a PR body.
  assert.equal(bash("gh pr create --title T --body \"$(cat <<'EOF'\nBody && gh pr view 2\nEOF\n)\""), true);
  assert.equal(withoutHeredocs("gh pr create --body \"$(cat <<'EOF'\nBody\nEOF\n)\""), "gh pr create --body \"$(cat <<'EOF'\n)\"");
});
