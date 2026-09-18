/**
 * Git im Inhaltsordner — und nur dort.
 *
 * Seit Inhalte und Werkzeug getrennt sind, gibt es zwei Repositories, und
 * Git sucht von sich aus nach oben weiter. Jeder Aufruf hier bekommt deshalb
 * ausdrücklich cwd: home.root und läuft nur, wenn es dort auch wirklich die
 * Wurzel eines Repositories ist (siehe repo.mjs).
 *
 * Zweitens steht hier die Liste der Pfade, die eine Veröffentlichung sichert.
 * Sie ist der Grund, warum die Änderungsübersicht, die ein Mitarbeiter
 * freigibt, und das, was "git add" tatsächlich vormerkt, dieselbe Liste sind
 * — und nicht zwei Listen, die jemand von Hand gleich halten muss.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

import { isRepositoryRoot } from './repo.mjs';

/**
 * Was eine Veröffentlichung sichert.
 *
 * Ausdrücklich ohne werkzeug/: welcher Stand des Werkzeugs gelten soll,
 * entscheidet die Betreuung des Projekts — nicht ein Veröffentlichen
 * nebenbei. Ohne dist/, generated/ und print-assets/: erzeugt. Ohne
 * app-data/: dort stehen Namen und Postadressen.
 */
export const PUBLISH_PATHS = Object.freeze([
  'content',
  'config',
  'i18n',
  'theme.css',
  'package.json',
  'README.md',
  '.gitignore',
  '.gitattributes',
  'sftp.env.example',
]);

/**
 * Davon das, was es hier wirklich gibt.
 *
 * "git status" übergeht einen Pfad, den es nicht gibt; "git add" bricht
 * damit ab ("fatal: pathspec 'i18n' did not match any files"). i18n/ und
 * theme.css sind aber ausdrücklich freiwillig — ohne diese Filterung
 * scheitert das Sichern in jedem Inhaltsordner, der sie nicht angelegt hat.
 */
export function existingPublishPaths(home) {
  return PUBLISH_PATHS.filter((entry) => fs.existsSync(path.join(home.root, entry)));
}

/** Git im Inhaltsordner. Liefert null, wenn der Aufruf scheitert. */
export function gitHome(home, argv, { allowFailure = true, raw = false } = {}) {
  try {
    const output = execFileSync('git', argv, {
      cwd: home.root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    // raw: bei "git submodule status" trägt das führende Leerzeichen
    // Bedeutung — beschneiden würde die Aussage verlieren.
    return raw ? output : output.trim();
  } catch (err) {
    if (allowFailure) return null;
    throw err;
  }
}

/**
 * Wertet "git status --porcelain=v1 -z" aus.
 *
 * -z ist nicht bequem, sondern nötig: ohne das zitiert und maskiert Git
 * jeden Pfad mit Zeichen ausserhalb von ASCII — und das hier ist ein
 * deutscher Inhaltsordner. Bei Umbenennungen folgt auf den neuen Pfad ein
 * zweites Feld mit dem alten.
 */
export function parsePorcelainZ(output) {
  if (!output) return [];
  const fields = output.split('\0');
  const entries = [];
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i];
    if (field.length < 4) continue;
    const code = field.slice(0, 2);
    const target = field.slice(3);
    if (code[0] === 'R' || code[0] === 'C') {
      entries.push({ code, path: target, from: fields[i + 1] ?? null });
      i += 1;
    } else {
      entries.push({ code, path: target, from: null });
    }
  }
  return entries;
}

/**
 * Zustand des Inhaltsordners.
 *
 * Die Pathspec ist das, was das Submodul werkzeug/ aus der Liste hält: es
 * steht dort, sobald der Werkzeugbaum schmutzig ist, und hat in einer
 * Änderungsübersicht der Inhalte nichts verloren.
 */
export function homeStatus(home) {
  if (!isRepositoryRoot(home.root)) {
    return { isRepo: false, branch: null, head: null, entries: [] };
  }
  const paths = existingPublishPaths(home);
  const raw = gitHome(
    home,
    ['status', '--porcelain=v1', '--untracked-files=all', '-z', '--', ...paths],
    { raw: true },
  );
  return {
    isRepo: true,
    branch: gitHome(home, ['branch', '--show-current']) || '(kein Branch)',
    head: gitHome(home, ['rev-parse', 'HEAD']),
    entries: parsePorcelainZ(raw ?? ''),
  };
}

/** SHA-256 einer Datei, oder null wenn es keine reguläre Datei ist. */
function fileHash(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return null;
    return `${stat.size}:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
  } catch {
    return null;
  }
}

/** Alle Dateien unterhalb eines Verzeichnisses, relativ und sortiert. */
function walk(dir, base = dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, out);
    else if (entry.isFile()) out.push(path.relative(base, full));
  }
  return out;
}

/**
 * Fingerabdruck ohne Git.
 *
 * Langsamer, aber er erhält die eine Eigenschaft, für die es den
 * Veröffentlichungstoken gibt: dass zwischen Prüfen und Bestätigen nichts
 * unbemerkt anders wird.
 */
export function contentFingerprint(home) {
  const hash = crypto.createHash('sha256');
  hash.update('ohne-git\n');
  for (const dir of [home.content, home.config, home.i18n]) {
    if (!dir || !fs.existsSync(dir)) continue;
    for (const relative of walk(dir)) {
      hash.update(`${path.basename(dir)}/${relative}\n`);
      hash.update(`${fileHash(path.join(dir, relative)) ?? 'fehlt'}\n`);
    }
  }
  if (home.themeCss && fs.existsSync(home.themeCss)) {
    hash.update(`theme.css\n${fileHash(home.themeCss) ?? 'fehlt'}\n`);
  }
  return hash.digest('hex');
}

/**
 * Fingerabdruck der Arbeitskopie — die Grundlage des Veröffentlichungstokens.
 *
 * Erfasst den Commit, jede gemeldete Änderung und den Inhalt jeder Datei,
 * die dabei genannt wird. Unverfolgte Dateien stehen zwar im Status, aber in
 * keinem Diff: ohne ihren Inhalt liesse sich die Druckdatei eines neuen
 * Flyers zwischen Prüfen und Bestätigen unbemerkt austauschen.
 *
 * Ausdrücklich nicht erfasst: das Submodul werkzeug/ (wird nie mitgesichert),
 * die erzeugten Ordner und app-data/.
 */
export function workspaceFingerprint(home, { baseUrl = '' } = {}) {
  const status = homeStatus(home);
  if (!status.isRepo) return contentFingerprint(home);

  const hash = crypto.createHash('sha256');
  hash.update(`head:${status.head ?? '(kein Commit)'}\n`);
  hash.update(`ziel:${baseUrl}\n`);

  const entries = [...status.entries].sort((a, b) => a.path.localeCompare(b.path));
  for (const entry of entries) {
    hash.update(`${entry.code}\t${entry.path}\t${entry.from ?? ''}\n`);
    // Der Arbeitsbaum ist das, was gebaut und hochgeladen wird — deshalb
    // zählt sein Inhalt, nicht der Unterschied zum Index.
    hash.update(`${fileHash(path.join(home.root, entry.path)) ?? 'geloescht'}\n`);
  }
  return hash.digest('hex');
}
