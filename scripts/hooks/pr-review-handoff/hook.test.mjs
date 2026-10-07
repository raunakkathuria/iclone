// Run: node --test scripts/hooks/pr-review-handoff/hook.test.mjs
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { agentName, commandDir, createResult, heredocsOpened, sameBranch, withoutHeredocs, fixPrompt, headBranch, isPrCreate, isReviewerPane, recentStarts, ownReviewerPane, repoOf, reviewerTool, reviewPrompt, splitDirection } from './hook.mjs';

function workerFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'prh-worker-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'bin');
  const state = join(dir, 'state');
  mkdirSync(bin);
  mkdirSync(state);
  const modeFile = join(dir, 'mode');
  const callsFile = join(dir, 'calls');
  const apiFile = join(dir, 'api');
  const url = 'https://github.com/example/repro/pull/1';
  const context = { HERDR_SOCKET_PATH: '/test.sock', HERDR_PANE_ID: 'wV:p1', HERDR_WORKSPACE_ID: 'wV' };
  writeFileSync(join(state, 'reviewers.json'), JSON.stringify({ '/test.sock|wV|example/repro|claude': 'wV:p2' }));
  writeFileSync(join(bin, 'gh'), `#!${process.execPath}\nconst fs=require('node:fs');
const args=process.argv.slice(2);
if(args[0]==='pr') console.log(JSON.stringify({url:${JSON.stringify(url)},number:1,state:'OPEN',createdAt:new Date().toISOString(),headRefName:'feat/repro'}));
else { const n=fs.existsSync(${JSON.stringify(apiFile)})?Number(fs.readFileSync(${JSON.stringify(apiFile)},'utf8')):0; fs.writeFileSync(${JSON.stringify(apiFile)},String(n+1)); console.log(JSON.stringify(n?[{submitted_at:'2026-01-01',html_url:${JSON.stringify(url + '#pullrequestreview-1')}}]:[])); }
`, { mode: 0o755 });
  writeFileSync(join(bin, 'herdr'), `#!${process.execPath}\nconst fs=require('node:fs');
const args=process.argv.slice(2); fs.appendFileSync(${JSON.stringify(callsFile)},JSON.stringify(args)+'\\n');
const mode=fs.readFileSync(${JSON.stringify(modeFile)},'utf8');
function fail(code){ console.error(JSON.stringify({error:{code,message:code}})); process.exit(1); }
let result={};
if(args[0]==='pane' && args[1]==='current') {
  if(mode==='missing') fail('pane_not_found');
  result={pane:{pane_id:mode==='moved'?'wN:p9':'wV:p1',workspace_id:mode==='moved'?'wN':'wV',agent:mode==='wrong-agent'?'claude':'codex',agent_session:{kind:'id',value:'builder-session'}}};
} else if(args[0]==='pane' && args[1]==='get') {
  if(mode==='layout-failed') fail('pane_not_found');
  result={pane:{pane_id:args[2],workspace_id:args[2].split(':')[0],...(args[2].endsWith(':p2')?{label:'claude review',agent:'claude'}:{agent:'codex'})}};
} else if(args[0]==='pane' && args[1]==='layout' && mode==='layout-failed') {
  fail('pane_not_found');
} else if(args[0]==='agent' && args[1]==='get') {
  if((mode==='release-false' || mode==='release-throws') && args[2]==='wV:p2') {
    const state=${JSON.stringify(state)};
    if(mode==='release-false') {
      const claim=state+'/handed-off/'+fs.readdirSync(state+'/handed-off')[0];
      fs.writeFileSync(claim,JSON.stringify({token:'another-worker'}));
    } else {
      const starts=state+'/review-starts/'+fs.readdirSync(state+'/review-starts')[0];
      fs.unlinkSync(starts); fs.mkdirSync(starts);
    }
    fail('agent_not_found');
  }
  if(mode==='startup-failed' && args[2]==='wV:p2') fail('agent_not_found');
  result={agent:{agent_status:'idle'}};
} else if(args[0]==='agent' && args[1]==='prompt' && args[3].startsWith('Review pull request') && mode==='delivery-unknown') fail('transport_error');
console.log(JSON.stringify({result}));
`, { mode: 0o755 });
  return {
    state,
    calls: () => existsSync(callsFile) ? readFileSync(callsFile, 'utf8').trim().split('\n').map(JSON.parse) : [],
    claimed: () => existsSync(join(state, 'handed-off')) && readdirSync(join(state, 'handed-off')).length > 0,
    starts: () => existsSync(join(state, 'review-starts')) ? readdirSync(join(state, 'review-starts')).flatMap(f => JSON.parse(readFileSync(join(state, 'review-starts', f), 'utf8'))) : [],
    run(mode) {
      writeFileSync(modeFile, mode);
      if (mode === 'moved') writeFileSync(join(state, 'reviewers.json'), JSON.stringify({ '/test.sock|wN|example/repro|claude': 'wN:p2' }));
      rmSync(apiFile, { force: true });
      const event = join(dir, 'event.json');
      writeFileSync(event, JSON.stringify({ cwd: dir, session_id: mode === 'wrong-session' ? 'another-session' : 'builder-session', tool_input: { command: 'gh pr create --head feat/repro' }, tool_response: url }));
      const run = spawnSync(process.execPath, [fileURLToPath(new URL('./hook.mjs', import.meta.url)), 'codex', '--worker', event], {
        env: { ...process.env, ...context, HERDR_ENV: '1', PR_REVIEWER: '', PR_REVIEW_MAX_PER_HOUR: '', PR_HANDOFF_STATE_DIR: state, HERDR_BIN_PATH: join(bin, 'herdr'), PATH: bin + ':' + process.env.PATH },
        encoding: 'utf8', timeout: 15000,
      });
      assert.equal(run.status, 0, run.stderr || run.error?.message);
      return readFileSync(join(state, 'log'), 'utf8');
    },
  };
}

test('a missing caller is reported without reserving a review or touching another pane', t => {
  const fixture = workerFixture(t);
  fixture.run('missing');
  assert.equal(fixture.claimed(), false);
  assert.equal(fixture.starts().length, 0);
  assert.ok(fixture.calls().some(args => args[0] === 'notification'));
  assert.ok(fixture.calls().some(args => args[0] === 'notification' && args.some(arg => arg.includes('Ask another agent to review'))));
  assert.ok(fixture.calls().every(args => args[0] === 'notification' || (args[0] === 'pane' && args[1] === 'current')));
});

test('the caller must still host the builder tool', t => {
  const fixture = workerFixture(t);
  fixture.run('wrong-agent');
  assert.equal(fixture.claimed(), false);
  assert.ok(fixture.calls().some(args => args[0] === 'notification'));
  assert.ok(!fixture.calls().some(args => args[0] === 'agent'));
});

test('a different agent session cannot claim the PR', t => {
  const fixture = workerFixture(t);
  fixture.run('wrong-session');
  assert.equal(fixture.claimed(), false);
  assert.ok(fixture.calls().some(args => args[0] === 'notification'));
  assert.ok(!fixture.calls().some(args => args[0] === 'agent'));
});

test('a moved caller uses the pane and workspace resolved by Herdr', t => {
  const fixture = workerFixture(t);
  assert.match(fixture.run('moved'), /review posted:/);
  assert.ok(fixture.calls().some(args => args[0] === 'pane' && args[1] === 'get' && args[2] === 'wN:p9'));
  assert.ok(fixture.calls().some(args => args[0] === 'agent' && args[1] === 'prompt' && args[2] === 'wN:p2'));
  assert.ok(!fixture.calls().some(args => args.includes('wV:p1') || args.includes('wV:p2')));
});

test('a layout failure releases the reservation and reports the error', t => {
  const fixture = workerFixture(t);
  assert.match(fixture.run('layout-failed'), /pane_not_found/);
  assert.equal(fixture.claimed(), false);
  assert.equal(fixture.starts().length, 0);
  assert.ok(fixture.calls().some(args => args[0] === 'notification'));
  assert.ok(!fixture.calls().some(args => args[0] === 'agent' && args[1] === 'prompt'));
});

test('failed reviewer startup releases the PR and hourly slot for a successful retry', t => {
  const fixture = workerFixture(t);
  fixture.run('startup-failed');
  assert.equal(fixture.claimed(), false);
  assert.equal(fixture.starts().length, 0);
  assert.ok(fixture.calls().some(args => args[0] === 'notification'));
  const log = fixture.run('ok');
  assert.equal(fixture.claimed(), true);
  assert.equal(fixture.starts().length, 1);
  assert.match(log, /review posted:/);
  assert.ok(fixture.calls().some(args => args[0] === 'agent' && args[1] === 'prompt' && args[3].startsWith('Review pull request')));
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
  const prompts = fixture.calls().filter(args => args[0] === 'agent' && args[1] === 'prompt').length;
  const log = fixture.run('ok');
  assert.match(log, /already handed off/);
  assert.equal(fixture.calls().filter(args => args[0] === 'agent' && args[1] === 'prompt').length, prompts);
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

test('repoOf gives owner/repo, so each repository gets its own reviewer', () => {
  assert.equal(repoOf('https://github.com/octo/demo/pull/14'), 'octo/demo');
  assert.notEqual(repoOf('https://github.com/o/a/pull/1'), repoOf('https://github.com/o/b/pull/1'));
});

test('headBranch reads --head and -H', () => {
  assert.equal(headBranch('gh pr create --fill'), null);
  assert.equal(headBranch('gh pr create --head feat/x --fill'), 'feat/x');
  assert.equal(headBranch('gh pr create --head=feat/x'), 'feat/x');
  assert.equal(headBranch('gh pr create -H "feat/y" --fill'), 'feat/y');
});

test('reviewerTool picks the other tool unless PR_REVIEWER chooses', () => {
  assert.equal(reviewerTool('claude'), 'codex');
  assert.equal(reviewerTool('codex'), 'claude');
  assert.equal(reviewerTool('claude', { PR_REVIEWER: 'claude' }), 'claude');
  assert.equal(reviewerTool('codex', { PR_REVIEWER: 'nonsense' }), 'claude');
});

test('agentName is a valid, unique Herdr name', () => {
  const name = agentName('codex', 'wW:p3');
  assert.equal(name, 'review-codex-ww-p3');
  assert.match(name, /^[a-z][a-z0-9_-]{0,31}$/);
  assert.notEqual(agentName('codex', 'wW:p3'), agentName('codex', 'wW:p4'));
  assert.ok(agentName('claude', 'w123456789:p123456789').length <= 32);
});

test('splitDirection splits wide panes right and tall panes down', () => {
  assert.equal(splitDirection({ width: 123, height: 33 }), 'right');
  assert.equal(splitDirection({ width: 60, height: 40 }), 'down');
  assert.equal(splitDirection(undefined), 'down');
});

test('ownReviewerPane reuses only a pane with the hook label, in the same workspace', () => {
  const pane = (over) => ({ pane_id: 'wV:p2', workspace_id: 'wV', label: 'codex review', agent: 'codex', ...over });
  assert.equal(ownReviewerPane(pane(), 'wV', 'codex'), 'reuse');
  assert.equal(ownReviewerPane(pane({ agent: null }), 'wV', 'codex'), 'restart');
  // The user's own Codex pane: same ID after a restart, but not our label.
  assert.equal(ownReviewerPane(pane({ label: null }), 'wV', 'codex'), null);
  assert.equal(ownReviewerPane(pane({ label: 'v3-codex' }), 'wV', 'codex'), null);
  assert.equal(ownReviewerPane(pane({ agent: 'claude' }), 'wV', 'codex'), null);
  assert.equal(ownReviewerPane(pane({ workspace_id: 'wW' }), 'wV', 'codex'), null);
  assert.equal(ownReviewerPane(null, 'wV', 'codex'), null);
});

test('reviewPrompt names the PR and forbids edits', () => {
  const text = reviewPrompt({ url: 'https://github.com/o/r/pull/7', number: 7 });
  assert.match(text, /pull\/7/);
  assert.match(text, /gh pr diff https:\/\/github.com\/o\/r\/pull\/7/);
  assert.match(text, /gh pr review https:\/\/github.com\/o\/r\/pull\/7 --comment/);
  assert.match(text, /Do not edit/);
  assert.doesNotMatch(text, /\n/);
});

test('fixPrompt asks the builder to fix, push and reply with each finding', () => {
  const text = fixPrompt({ url: 'https://github.com/o/r/pull/7', number: 7 }, 'https://github.com/o/r/pull/7#pullrequestreview-1', 'codex');
  assert.match(text, /^codex reviewed your pull request https:\/\/github.com\/o\/r\/pull\/7/);
  assert.match(text, /pullrequestreview-1/);
  assert.match(text, /gh pr comment https:\/\/github.com\/o\/r\/pull\/7 --body-file/);
  assert.match(text, /not fixed" with the reason/);
  assert.doesNotMatch(text, /\n/);
});

test('isReviewerPane stops a reviewer pane from starting another review', () => {
  const saved = { '/s.sock|wV|o/r|codex': 'wV:p2', '/other.sock|wV|o/r|codex': 'wV:p5' };
  assert.equal(isReviewerPane(saved, '/s.sock', { pane_id: 'wV:p2', label: 'codex review' }), true);
  // A builder pane, and a reviewer pane of another server, are not reviewers here.
  assert.equal(isReviewerPane(saved, '/s.sock', { pane_id: 'wV:p1', label: 'claude build' }), false);
  assert.equal(isReviewerPane(saved, '/s.sock', { pane_id: 'wV:p5', label: 'codex review' }), false);
  // After a restart the ID may belong to a user's pane: no hook label, so not a reviewer.
  assert.equal(isReviewerPane(saved, '/s.sock', { pane_id: 'wV:p2', label: 'my notes' }), false);
  assert.equal(isReviewerPane(saved, '/s.sock', null), false);
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
