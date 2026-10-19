#!/usr/bin/env node
// A fake `herdr` CLI for the tests. It keeps its panes, its mode and every call in the JSON file
// named by FAKE_HERDR_STATE: { mode, current, panes, next, calls, workspaces? }. A workspace
// missing from workspaces is labelled with its ID.
const fs = require('node:fs');

const file = process.env.FAKE_HERDR_STATE;
const st = JSON.parse(fs.readFileSync(file, 'utf8'));
const args = process.argv.slice(2);
st.calls.push(args);
const save = () => fs.writeFileSync(file, JSON.stringify(st));
const out = (result) => { save(); console.log(JSON.stringify({ result })); process.exit(0); };
const fail = (code) => { save(); console.error(JSON.stringify({ error: { code, message: code } })); process.exit(1); };
const pane = (id) => st.panes.find((p) => p.pane_id === id);
const opt = (name) => args[args.indexOf(name) + 1];
const { mode } = st;
const [group, command] = args;

if (group === 'notification') out({});
if (group === 'workspace') {
  st.workspaces ??= [];
  const ws = (id) => st.workspaces.find((w) => w.workspace_id === id);
  if (command === 'get') out({ workspace: ws(args[2]) ?? { workspace_id: args[2], label: args[2] } });
  if (command === 'list') out({ workspaces: st.workspaces });
  if (command === 'create') {
    const id = `w${st.next++}`;
    const root = { pane_id: `${id}:p${st.next++}`, workspace_id: id, tab_id: `${id}:t1`, cwd: opt('--cwd') };
    st.workspaces.push({ workspace_id: id, label: opt('--label') });
    st.panes.push(root);
    out({ workspace: { workspace_id: id }, root_pane: { pane_id: root.pane_id } });
  }
  if (command === 'close') {
    if (!ws(args[2])) fail('workspace_not_found');
    st.workspaces = st.workspaces.filter((w) => w.workspace_id !== args[2]);
    st.panes = st.panes.filter((p) => p.workspace_id !== args[2]);
    out({});
  }
}
if (group === 'pane') {
  if (command === 'current') {
    if (mode === 'missing') fail('pane_not_found');
    return pane(st.current) ? out({ pane: pane(st.current) }) : fail('pane_not_found');
  }
  if (command === 'list') {
    const workspace = args[2] === '--workspace' ? args[3] : null;
    if (workspace && mode === 'layout-failed') fail('pane_not_found');
    out({ panes: st.panes.filter((p) => !workspace || p.workspace_id === workspace) });
  }
  if (command === 'get') return pane(args[2]) ? out({ pane: pane(args[2]) }) : fail('pane_not_found');
  if (command === 'rename') { pane(args[2]).label = args[3]; out({}); }
  if (command === 'layout') out({ layout: { panes: [{ pane_id: opt('--pane'), rect: { width: 200, height: 50 } }] } });
  if (command === 'process-info') out({ process_info: { foreground_process_group_id: mode === 'busy' ? 2 : 1, shell_pid: 1 } });
  if (command === 'split') {
    const from = pane(opt('--pane'));
    const id = `${from.workspace_id}:p${st.next++}`;
    st.panes.push({ pane_id: id, workspace_id: from.workspace_id, tab_id: from.tab_id, cwd: opt('--cwd') });
    out({ pane: { pane_id: id } });
  }
}
if (group === 'agent') {
  if (command === 'start') { pane(opt('--pane')).agent = opt('--kind'); out({ agent: { pane_id: opt('--pane') } }); }
  if (command === 'get') {
    const reviewer = ['reviewer', 'reviewer-minion'].includes(pane(args[2])?.label);
    if (reviewer && (mode === 'release-false' || mode === 'release-throws')) {
      const state = process.env.PR_HANDOFF_STATE_DIR;
      if (mode === 'release-false') {
        const claim = `${state}/handed-off/${fs.readdirSync(`${state}/handed-off`)[0]}`;
        fs.writeFileSync(claim, JSON.stringify({ token: 'another-worker' }));
      } else {
        const starts = `${state}/review-starts/${fs.readdirSync(`${state}/review-starts`)[0]}`;
        fs.unlinkSync(starts);
        fs.mkdirSync(starts);
      }
      fail('agent_not_found');
    }
    if (reviewer && mode === 'startup-failed') fail('agent_not_found');
    // In mode flicker, the reviewer looks idle for a moment in the middle of its review, and
    // writes its findings only after that.
    if (reviewer && mode === 'flicker' && st.pendingFindings) {
      st.flicker = (st.flicker ?? 0) + 1;
      if (st.flicker === 2) { fs.writeFileSync(st.pendingFindings, 'No findings.\n'); delete st.pendingFindings; }
      out({ agent: { agent_status: st.flicker === 2 ? 'working' : 'idle' } });
    }
    out({ agent: { agent: pane(args[2])?.agent, agent_status: 'idle' } });
  }
  if (command === 'prompt') {
    if (mode === 'delivery-unknown' && args[3].startsWith('Review pull request')) fail('transport_error');
    // The reviewer of local changes writes its findings file.
    // In mode drop-first, the first review prompt is lost, as Codex does after /new.
    const findings = /The only file you write is (\S+\.md)/.exec(args[3]);
    if (findings) st.reviewPrompts = (st.reviewPrompts ?? 0) + 1;
    const dropped = mode === 'drop-first' && st.reviewPrompts === 1;
    if (findings && mode === 'flicker') st.pendingFindings = findings[1];
    else if (findings && mode !== 'no-findings-file' && !dropped) fs.writeFileSync(findings[1], 'No findings.\n');
    out({});
  }
}
out({});
