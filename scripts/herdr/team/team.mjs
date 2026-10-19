#!/usr/bin/env node
// team: how the minions and Gru talk to each other. Run it anywhere inside a project that has a
// .team/ folder (team-up makes it). The commands are in USAGE below.
//
// Files are the record: every message goes to .team/LOG.md, escalations to ESCALATIONS.md,
// decisions to DECISIONS.md, and lessons to LESSONS.md. A message is typed into the minion's pane
// and never waits for an answer, so two minions can never wait on each other.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { MINIONS, herdr, notify, roleNote, roleOf, teamLabel } from '../lib/herdr.mjs';
import { addLesson, lessonBody, oneWhy, takeWatching } from './lessons.mjs';

const USAGE = `Usage:
  team say <minion> <message>                 message builder, reviewer, product or qa
  team escalate <topic>                       ask Gru for a decision
  team decide <E-n> <decision> [revisit if]   Gru answers an escalation
  team learn <rule> --from <source>           add a lesson to .team/LESSONS.md
  team learn <W-n>                            move a Watching line up to the lessons
  team status                                 the board, open escalations, latest decisions
  team down                                   close the team workspace`;

const [command, ...args] = process.argv.slice(2);
if (!['say', 'escalate', 'decide', 'learn', 'status', 'down'].includes(command)) {
  console.error(USAGE);
  process.exit(command ? 1 : 0);
}

function fail(message) {
  console.error(`team: ${message}`);
  process.exit(1);
}

// The project folder: the nearest folder, from here up, that has a .team/ folder.
function projectRoot(dir = process.cwd()) {
  for (let d = dir; ; d = dirname(d)) {
    if (existsSync(join(d, '.team'))) return d;
    if (d === dirname(d)) fail('no .team/ folder here or above. Run team-up first.');
  }
}

const root = projectRoot();
const file = (name) => join(root, '.team', name);
const read = (name) => (existsSync(file(name)) ? readFileSync(file(name), 'utf8') : '');
const now = () => new Date().toISOString().slice(0, 16).replace('T', ' ');
const log = (line) => appendFileSync(file('LOG.md'), `${now()} ${line}\n`);

// The team's Herdr workspace, or null when the team is not running. The caller's own workspace
// wins when two projects share a folder name.
function teamWorkspace() {
  let all = [];
  try { all = herdr('workspace', 'list').workspaces.filter((w) => w.label === teamLabel(root)); } catch { /* no Herdr */ }
  return all.find((w) => w.workspace_id === process.env.HERDR_WORKSPACE_ID) ?? all[0] ?? null;
}

const minionPanes = (ws) => herdr('pane', 'list', '--workspace', ws.workspace_id).panes.filter((p) => roleOf(p.label));

// Who is calling: the minion whose pane runs this command, or Gru from anywhere else.
function caller(ws) {
  try {
    const pane = herdr('pane', 'current', '--current').pane;
    if (ws && pane?.workspace_id === ws.workspace_id && roleOf(pane.label)) return roleOf(pane.label);
  } catch { /* not in a Herdr pane */ }
  return 'gru';
}
const nameOf = (role) => MINIONS[role] ?? role;

// The next free ID: E-3 after E-1 and E-2.
const nextId = (text, prefix) => `${prefix}-${Math.max(0, ...[...text.matchAll(new RegExp(`^## ${prefix}-(\\d+)`, 'gm'))].map((m) => Number(m[1]))) + 1}`;

const ws = teamWorkspace();
const me = caller(ws);

if (command === 'say') {
  const [to, ...words] = args;
  const role = roleOf(to) ?? roleOf(`${to}-minion`);
  if (!role || !words.length) fail(`usage: team say <builder|reviewer|product|qa> <message>`);
  const message = words.join(' ');
  if (!ws) fail(`the team is not running. Start it with team-up.`);
  const pane = minionPanes(ws).find((p) => roleOf(p.label) === role);
  if (!pane) fail(`no ${MINIONS[role]} pane in workspace ${ws.workspace_id}.`);
  log(`${nameOf(me)} -> ${MINIONS[role]}: ${message}`);
  const reply = me === 'gru' ? '' : ` (to reply: team say ${me} "...")`;
  try {
    herdr('agent', 'prompt', pane.pane_id, `[from ${nameOf(me)}] ${roleNote(role, pane.agent)}${message}${reply}`);
  } catch (e) {
    if (e.code === 'agent_blocked') fail(`${MINIONS[role]} is waiting at a question in its pane. Gru must answer it first. The message is in .team/LOG.md.`);
    throw e;
  }
  console.log(`sent to ${MINIONS[role]}`);
} else if (command === 'escalate') {
  const topic = args.join(' ');
  if (!topic) fail('usage: team escalate <topic>');
  const id = nextId(read('ESCALATIONS.md'), 'E');
  const details = `.team/handoffs/${id}.md`;
  appendFileSync(file('ESCALATIONS.md'), `\n## ${id} (${now()}, raised by ${nameOf(me)}) OPEN\nTopic: ${topic}\nDetails: ${details}\n`);
  if (!existsSync(join(root, details))) {
    writeFileSync(join(root, details), `# ${id}: ${topic}\n\n## Option A\n\n## Option B\n\n## Best argument for each\n\n## Recommendation\n\n## Cost of waiting\n`);
  }
  log(`${nameOf(me)} escalated ${id}: ${topic}`);
  notify('Gru, a decision is needed', `${basename(root)} ${id}: ${topic}`);
  console.log(`${id}. Fill in ${details}, then wait for Gru's decision.`);
} else if (command === 'decide') {
  const [id, decision, revisit = 'not stated'] = args;
  if (!/^E-\d+$/.test(id ?? '') || !decision) fail('usage: team decide <E-n> <decision> [revisit if]');
  const open = `## ${id} (`;
  const text = read('ESCALATIONS.md');
  const at = text.split('\n').findIndex((l) => l.startsWith(open) && l.endsWith(' OPEN'));
  if (at < 0) fail(`${id} is not an open escalation.`);
  const did = nextId(read('DECISIONS.md'), 'D');
  appendFileSync(file('DECISIONS.md'), `\n## ${did} (${now()}, Gru, resolves ${id})\nDecision: ${decision}\nRevisit if: ${revisit}\n`);
  const lines = text.split('\n');
  lines[at] = `${lines[at].slice(0, -' OPEN'.length)} CLOSED by ${did}`;
  writeFileSync(file('ESCALATIONS.md'), lines.join('\n'));
  log(`gru decided ${did} (resolves ${id}): ${decision}`);
  if (!ws) console.log('The team is not running, so no minion was told.');
  for (const pane of ws ? minionPanes(ws).filter((p) => p.agent) : []) {
    try {
      herdr('agent', 'prompt', pane.pane_id, `Gru decided ${did} (resolves ${id}): ${decision}. It is in .team/DECISIONS.md. Commit to it and continue.`);
    } catch (e) { console.error(`team: could not tell ${pane.label}: ${e.code}`); }
  }
  console.log(did);
} else if (command === 'learn') {
  // A new lesson from a rule and a source, or the W-n line that moves up from Watching.
  const [rule, flag, source] = args;
  const watching = args.length === 1 && /^W-\d+$/.test(rule) ? rule : null;
  // The rule and the source are one line each, so a lesson can never add a second line to the file.
  const oneLine = (text) => !/[\r\n]/.test(text) && text.trim();
  if (!watching && (args.length !== 3 || flag !== '--from' || !oneLine(rule) || !oneLine(source))) {
    fail('usage: team learn <rule> --from <source>, or team learn <W-n>');
  }
  let body = watching ? null : lessonBody(rule.trim(), source.trim());
  if (body && !oneWhy(body)) fail('a rule or source cannot contain "Why:". It separates the two in the lesson line.');
  if (!existsSync(file('LESSONS.md'))) fail('there is no .team/LESSONS.md. Run team-up to create it.');
  let text = read('LESSONS.md');
  let id;
  try {
    if (watching) ({ text, body } = takeWatching(text, watching));
    ({ text, id } = addLesson(text, body));
  } catch (e) { fail(`.team/LESSONS.md ${e.message}`); }
  writeFileSync(file('LESSONS.md'), text);
  log(`${nameOf(me)} learned ${id}${watching ? ` from ${watching}` : ''}: ${body}`);
  console.log(id);
} else if (command === 'status') {
  console.log(read('BOARD.md').trim());
  const open = read('ESCALATIONS.md').split('\n').filter((l) => /^## E-\d+ .* OPEN$/.test(l));
  console.log(`\nOpen escalations:\n${open.join('\n') || '(none)'}`);
  const decisions = read('DECISIONS.md').split('\n').filter((l) => /^## D-\d+/.test(l)).slice(-5);
  console.log(`\nLatest decisions:\n${decisions.join('\n') || '(none)'}`);
  console.log(`\nTeam workspace: ${ws ? ws.workspace_id : 'not running'}`);
} else if (command === 'down') {
  if (!ws) fail('the team is not running.');
  herdr('workspace', 'close', ws.workspace_id);
  console.log(`closed ${ws.label}`);
}
