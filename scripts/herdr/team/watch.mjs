// What `team watch` shows Guru: whether Guru needs to act, where the tasks stand, and the last
// message. Pure functions on the files' text; team.mjs reads the files and the panes and draws it.

const COLORS = { red: 31, green: 32, yellow: 33 };
const paint = (color, text) => (color ? `\x1b[1;${COLORS[color]}m${text}\x1b[0m` : text);

// The open escalations, as "E-2: <topic>".
export function openEscalations(text) {
  const lines = text.split('\n');
  return lines.flatMap((line, i) => {
    const open = /^## (E-\d+) .* OPEN$/.exec(line);
    return open ? [`${open[1]}: ${(lines[i + 1] ?? '').replace(/^Topic: /, '')}`] : [];
  });
}

// The board's tasks, as [ID, status].
export function boardTasks(text) {
  return text.split('\n').filter((line) => /^\| T-/.test(line))
    .map((line) => line.split('|').map((cell) => cell.trim())).map((cells) => [cells[1], cells[4]]);
}

// Breaks a line into lines of at most width characters, at a space where it can.
export function wrap(text, width) {
  const lines = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line && line.length + 1 + word.length > width) { lines.push(line); line = ''; }
    line = line ? `${line} ${word}` : word;
    while (line.length > width) { lines.push(line.slice(0, width)); line = line.slice(width); }
  }
  return [...lines, line];
}

// The view, as at most rows lines of at most width characters. The first line answers "does
// Guru need to act?". idleMinutes is how long every minion has been idle; null when the team is
// not running.
export function render({ escalations, tasks, lastLog, idleMinutes, time, width, rows }) {
  const open = tasks.filter(([, status]) => status !== 'DONE').map(([id]) => id);
  const entries = escalations.length
    ? [['red', 'Guru, a decision is needed:'], ...escalations.map((e) => [null, e]), [null, 'Answer: team decide E-n <decision> --revisit <when>']]
    : [['green', `Nothing needs you. ${time}`]];
  if (idleMinutes === null) entries.push(['yellow', 'The team is not running. Start it with team-up.']);
  else if (idleMinutes >= 5 && open.length) {
    entries.push(['yellow', `Every minion has been idle for ${idleMinutes} minutes, but ${open.join(', ')} ${open.length === 1 ? 'is' : 'are'} not DONE. Nudge one with team say.`]);
  }
  if (tasks.length) entries.push([null, tasks.map(([id, status]) => `${id} ${status}`).join('  ')]);
  if (lastLog) entries.push([null, lastLog]);
  // Text from the record files is drawn as plain characters: an escape code could clear the view.
  const plain = (text) => text.replace(/[\x00-\x1f\x7f]/g, '');
  return entries.flatMap(([color, text]) => wrap(plain(text), width).map((line) => paint(color, line))).slice(0, rows);
}
