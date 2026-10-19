#!/usr/bin/env node
// team: how the minions and Gru talk to each other. Run it anywhere inside a project that has a
// .team/ folder (team-up makes it). The commands are in USAGE below.
//
// Files are the record: every message goes to .team/LOG.md, escalations to ESCALATIONS.md,
// decisions to DECISIONS.md, and lessons to LESSONS.md. A message is typed into the minion's pane
// and never waits for an answer, so two minions can never wait on each other.
import { appendFileSync, existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { MINIONS, findTeam, herdr, notify, roleNote, roleOf, sleep } from '../lib/herdr.mjs';
import { promptFile } from '../lib/minions.mjs';
import { boardTasks, openEscalations, render } from './watch.mjs';
import { PROMOTED, addLesson, addPromoted, findLesson, lessonBody, oneWhy, takeWatching } from './lessons.mjs';

const USAGE = `Usage:
  team say <minion> <message>                       message a minion, by name: builder, qa, ...
  team escalate <topic>                             ask Gru for a decision
  team decide <E-n> <decision> [--revisit <when>]   Gru answers an escalation
  team learn <rule> --from <source>                 add a lesson to .team/LESSONS.md
  team learn <W-n>                                  move a Watching line up to the lessons
  team promote <L-n>                                Gru gives a lesson to every new project
  team status                                       the board, open escalations, latest decisions
  team watch                                        Gru's view: does Gru need to act? Every 10 seconds
  team down                                         Gru closes the team workspace`;

const [command, ...args] = process.argv.slice(2);
if (!['say', 'escalate', 'decide', 'learn', 'promote', 'status', 'watch', 'down'].includes(command)) {
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
// Local time, as Gru reads it: "2026-10-19 21:16".
const now = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16).replace('T', ' ');
};
const log = (line) => appendFileSync(file('LOG.md'), `${now()} ${line}\n`);

const minionPanes = (ws) => herdr('pane', 'list', '--workspace', ws.workspace_id).panes.filter((p) => roleOf(p.label));

// The Herdr pane that runs this command, or null outside Herdr.
function currentPane() {
  try { return herdr('pane', 'current', '--current').pane; } catch { return null; }
}

// Who is calling: the minion whose pane in the team's workspace runs this command, or Gru from
// anywhere else.
function caller(ws, pane) {
  return ws && pane?.workspace_id === ws.workspace_id && roleOf(pane.label) ? roleOf(pane.label) : 'gru';
}
const nameOf = (role) => MINIONS[role] ?? role;

// Text that goes into a record file must be one line: a line break could add a fake entry,
// such as a second "## E-n ... OPEN" heading.
const oneLine = (text) => !/[\r\n]/.test(text) && text.trim();

// Gru's commands refuse a minion pane in any workspace, and a Herdr pane that cannot be looked
// up: a minion with a broken herdr must not pass as Gru.
function gruOnly(what) {
  if (roleOf(here?.label) || (!here && process.env.HERDR_PANE_ID)) {
    fail(`only Gru can ${what}. Run it outside the minion panes, for example in the gru pane.`);
  }
}

// The next free ID: E-3 after E-1 and E-2.
const nextId = (text, prefix) => `${prefix}-${Math.max(0, ...[...text.matchAll(new RegExp(`^## ${prefix}-(\\d+)`, 'gm'))].map((m) => Number(m[1]))) + 1}`;

const ws = findTeam(root);
const here = currentPane();
const me = caller(ws, here);

if (command === 'say') {
  const [to, ...words] = args;
  const role = roleOf(to) ?? roleOf(`${to}-minion`);
  if (!role || !words.length) fail(`usage: team say <minion> <message>. The minions: ${Object.keys(MINIONS).join(', ')}.`);
  const message = words.join(' ');
  if (!oneLine(message)) fail('a message must be one line.');
  if (!ws) fail(`the team is not running. Start it with team-up.`);
  const pane = minionPanes(ws).find((p) => roleOf(p.label) === role);
  if (!pane) fail(`no ${MINIONS[role]} pane in workspace ${ws.workspace_id}.`);
  log(`${nameOf(me)} -> ${MINIONS[role]}: ${message}`);
  const reply = me === 'gru' ? '' : ` (to reply: team say ${me} "...")`;
  try {
    herdr('agent', 'prompt', pane.pane_id, `[from ${nameOf(me)}] ${roleNote(role, pane.agent, promptFile(root, role))}${message}${reply}`);
  } catch (e) {
    if (e.code === 'agent_blocked') fail(`${MINIONS[role]} is waiting at a question in its pane. Gru must answer it first. The message is in .team/LOG.md.`);
    throw e;
  }
  console.log(`sent to ${MINIONS[role]}`);
} else if (command === 'escalate') {
  const topic = args.join(' ');
  if (!topic) fail('usage: team escalate <topic>');
  if (!oneLine(topic)) fail('a topic must be one line. Put the details in the handoff file.');
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
  // The words after the ID are the decision, up to --revisit; the words after it say when to
  // revisit. No quotes are needed, and no word is dropped.
  gruOnly('decide an escalation');
  const [id, ...words] = args;
  const at = words.indexOf('--revisit');
  const decision = (at < 0 ? words : words.slice(0, at)).join(' ');
  const revisit = at < 0 ? 'not stated' : words.slice(at + 1).join(' ');
  if (!/^E-\d+$/.test(id ?? '') || !decision || (at >= 0 && !revisit)) fail('usage: team decide <E-n> <decision> [--revisit <when>]');
  if (!oneLine(decision) || !oneLine(revisit)) fail('a decision and its revisit text must be one line each.');
  const open = `## ${id} (`;
  const text = read('ESCALATIONS.md');
  const line = text.split('\n').findIndex((l) => l.startsWith(open) && l.endsWith(' OPEN'));
  if (line < 0) fail(`${id} is not an open escalation.`);
  const did = nextId(read('DECISIONS.md'), 'D');
  appendFileSync(file('DECISIONS.md'), `\n## ${did} (${now()}, Gru, resolves ${id})\nDecision: ${decision}\nRevisit if: ${revisit}\n`);
  const lines = text.split('\n');
  lines[line] = `${lines[line].slice(0, -' OPEN'.length)} CLOSED by ${did}`;
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
} else if (command === 'promote') {
  // The global list reaches every later project, so a minion pane in any workspace is refused.
  const [id] = args;
  if (args.length !== 1 || !/^L-\d+$/.test(id)) fail('usage: team promote <L-n>');
  gruOnly('promote a lesson');
  if (!existsSync(file('LESSONS.md'))) fail('there is no .team/LESSONS.md. Run team-up to create it.');
  let body;
  let list;
  try { body = findLesson(read('LESSONS.md'), id); } catch (e) { fail(`.team/LESSONS.md ${e.message}`); }
  // A missing list, or a link to a list that does not exist yet, reads as empty.
  try { list = addPromoted(existsSync(PROMOTED) ? readFileSync(PROMOTED, 'utf8') : '', body, `${basename(root)} ${id}`); } catch (e) { fail(`${PROMOTED} ${e.message}`); }
  // Write through the D-1 link: a new file and a rename would replace the link.
  try { writeFileSync(PROMOTED, list); } catch (e) { fail(`cannot write ${PROMOTED} (${e.code}). Nothing was promoted.`); }
  log(`${nameOf(me)} promoted ${id} to ${PROMOTED}: ${body}`);
  const real = realpathSync(PROMOTED);
  console.log(`Promoted ${id} to ${PROMOTED}${real === PROMOTED ? '' : ` (that is ${real})`}.`);
  console.log('team promote does not commit. Commit that file in its repository.');
} else if (command === 'status') {
  console.log(read('BOARD.md').trim());
  const open = read('ESCALATIONS.md').split('\n').filter((l) => /^## E-\d+ .* OPEN$/.test(l));
  console.log(`\nOpen escalations:\n${open.join('\n') || '(none)'}`);
  const decisions = read('DECISIONS.md').split('\n').filter((l) => /^## D-\d+/.test(l)).slice(-5);
  console.log(`\nLatest decisions:\n${decisions.join('\n') || '(none)'}`);
  console.log(`\nTeam workspace: ${ws ? ws.workspace_id : 'not running'}`);
} else if (command === 'watch') {
  // Redraws until Ctrl-C. "Idle" counts from the last time Herdr showed any minion working.
  let busyAt = Date.now();
  for (;;) {
    const team = findTeam(root);
    let panes = [];
    try { panes = team ? minionPanes(team) : []; } catch { /* Herdr is restarting */ }
    if (panes.some((p) => !['idle', 'done'].includes(p.agent_status))) busyAt = Date.now();
    const lines = render({
      escalations: openEscalations(read('ESCALATIONS.md')),
      tasks: boardTasks(read('BOARD.md')),
      lastLog: read('LOG.md').trim().split('\n').at(-1)?.slice(11) ?? '',
      idleMinutes: team ? Math.floor((Date.now() - busyAt) / 60_000) : null,
      time: now().slice(11),
      width: process.stdout.columns || 80,
      rows: (process.stdout.rows || 24) - 1,
    });
    process.stdout.write(`\x1b[2J\x1b[H${lines.join('\n')}`);
    await sleep(10_000);
  }
} else if (command === 'down') {
  gruOnly('close the team');
  if (!ws) fail('the team is not running.');
  herdr('workspace', 'close', ws.workspace_id);
  console.log(`closed ${ws.label}`);
}
