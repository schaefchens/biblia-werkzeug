/**
 * Die zwei Verzeichnisbäume dieses Projekts.
 *
 * SYS  — das Werkzeug. Kommt mit jedem Update mit und gehört niemandem
 *        persönlich: Skripte, Vorlagen, Stilvorlagen, PHP-Endpunkte und
 *        die Redaktionsoberfläche.
 *
 * home — der Inhaltsordner. Alles, was dem Verein gehört: Flyer, Seiten,
 *        Einstellungen, Zugangsdaten, Bestelldaten und die erzeugte Website.
 *        Hier — und nur hier — arbeiten die Mitarbeiter.
 *
 * Die Trennung ist der Grund, warum sich das Werkzeug aktualisieren lässt,
 * ohne Inhalte anzufassen, und warum Passwort und Postadressen nicht im
 * Quelltext-Verzeichnis liegen.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail } from './log.mjs';

const SYS_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

/** Verzeichnisse des Werkzeugs. */
export const SYS = Object.freeze({
  root: SYS_ROOT,
  scripts: path.join(SYS_ROOT, 'scripts'),
  src: path.join(SYS_ROOT, 'src'),
  css: path.join(SYS_ROOT, 'src', 'css'),
  js: path.join(SYS_ROOT, 'src', 'js'),
  i18n: path.join(SYS_ROOT, 'src', 'i18n'),
  server: path.join(SYS_ROOT, 'server'),
  packageJson: path.join(SYS_ROOT, 'package.json'),
  sftpEnvExample: path.join(SYS_ROOT, 'sftp.env.example'),
  /** Vorlagen für einen neuen Inhaltsordner. */
  templates: path.join(SYS_ROOT, 'scripts', 'templates'),
});

/** Daran ist ein Inhaltsordner zu erkennen. */
export const HOME_MARKER = path.join('config', 'site.json');

/** Der Name des Submoduls im Inhaltsordner. */
export const WERKZEUG_DIR = 'werkzeug';

/** Liegt hier ein Inhaltsordner? */
export function isHome(dir) {
  return Boolean(dir) && fs.existsSync(path.join(dir, HOME_MARKER));
}

/** Alle Pfade eines Inhaltsordners. */
export function homeDirs(root) {
  const at = (...parts) => path.join(root, ...parts);
  return Object.freeze({
    root,

    // Inhalte. Die vier Schlüssel flyers/pages/topics/categories sind
    // zugleich das, was loadContent() als "dirs" erwartet.
    content: at('content'),
    flyers: at('content', 'flyers'),
    pages: at('content', 'pages'),
    topics: at('content', 'topics'),
    categories: at('content', 'categories'),

    // Einstellungen und Zugangsdaten.
    config: at('config'),
    siteConfig: at('config', 'site.json'),
    sftpEnv: at('sftp.env'),
    sftpEnvExample: at('sftp.env.example'),

    // Eigene Ergänzungen, beide freiwillig.
    i18n: at('i18n'),
    themeCss: at('theme.css'),

    // Erzeugtes. Jederzeit wegwerfbar.
    generated: at('generated'),
    cache: at('generated', '.cache'),
    dist: at('dist'),
    printAssets: at('print-assets'),

    // Laufzeitdaten vom Server. Enthält Namen und Postadressen.
    appData: at('app-data'),

    /** Das Werkzeug als Submodul — nur vorhanden im fertigen Inhaltsordner. */
    werkzeug: at(WERKZEUG_DIR),
  });
}

/** Der zuletzt aufgelöste Inhaltsordner — nur für lesbare Meldungen in rel(). */
let current = null;

function option(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] ?? null : null;
}

/** Das Verzeichnis und alle darüberliegenden, von innen nach außen. */
function ancestors(from) {
  const out = [];
  let dir = path.resolve(from);
  for (;;) {
    out.push(dir);
    const parent = path.dirname(dir);
    if (parent === dir) return out;
    dir = parent;
  }
}

function notAHome(root, why) {
  fail(
    `${why}: ${root}`,
    'Ein Inhaltsordner enthält die Datei config/site.json.\n' +
      '  Einen neuen anlegen:  node <werkzeug>/scripts/init.mjs <pfad>',
  );
}

/**
 * Findet den Inhaltsordner.
 *
 * Reihenfolge:
 *   1. --home <pfad>
 *   2. BIBLIA_HOME
 *   3. das aktuelle Verzeichnis oder eines darüber mit config/site.json
 *   4. <werkzeug>/home — nur für die Entwicklung am Werkzeug selbst
 *
 * Wird bewusst nicht beim Laden dieser Datei aufgerufen: ohne Inhaltsordner
 * sollen sich die Bausteine trotzdem einbinden lassen, etwa in den Tests.
 *
 * @param {object} [options]
 * @param {boolean} [options.developmentFallback] Punkt 4 mitsuchen (Vorgabe: ja)
 */
export function findHome({
  argv = process.argv,
  cwd = process.cwd(),
  env = process.env,
  developmentFallback = true,
} = {}) {
  // Eine ausdrückliche Angabe, die nicht stimmt, ist immer ein Fehler:
  // stillschweigend woanders zu suchen wäre die schlechtere Antwort.
  const chosen = option(argv, '--home');
  if (chosen) {
    const root = path.resolve(cwd, chosen);
    if (!isHome(root)) notAHome(root, 'Unter --home liegt kein Inhaltsordner');
    return remember(homeDirs(root));
  }

  if (env.BIBLIA_HOME) {
    const root = path.resolve(cwd, env.BIBLIA_HOME);
    if (!isHome(root)) notAHome(root, 'BIBLIA_HOME zeigt auf keinen Inhaltsordner');
    return remember(homeDirs(root));
  }

  for (const dir of ancestors(cwd)) {
    if (isHome(dir)) return remember(homeDirs(dir));
  }

  if (developmentFallback) {
    const development = path.join(SYS.root, 'home');
    if (isHome(development)) return remember(homeDirs(development));
  }

  return null;
}

/**
 * Wie findHome(), bricht aber ab, wenn kein Inhaltsordner zu finden ist.
 * Das ist der Normalfall für alle Befehle ausser npm run doctor — der soll
 * gerade dann noch etwas sagen können, wenn nichts eingerichtet ist.
 */
export function resolveHome(options = {}) {
  const found = findHome(options);
  if (found) return found;

  const cwd = options.cwd ?? process.cwd();
  fail(
    'Kein Inhaltsordner gefunden.',
    'Die Befehle werden im Inhaltsordner ausgeführt — dort liegen Flyer,\n' +
      '  Einstellungen und Zugangsdaten.\n\n' +
      `  Aktuelles Verzeichnis:  ${cwd}\n\n` +
      '  Einen vorhandenen Inhaltsordner holen:\n' +
      '      git clone --recurse-submodules <adresse>\n\n' +
      '  Einen neuen anlegen:\n' +
      `      node ${path.join(SYS.scripts, 'init.mjs')} <pfad>`,
  );
}

function remember(dirs) {
  current = dirs;
  return dirs;
}

/** Nur für die Tests: den gemerkten Inhaltsordner zurücksetzen. */
export function forgetHome() {
  current = null;
}

const inside = (target, base) => target === base || target.startsWith(base + path.sep);

/**
 * Pfad in lesbarer Kurzform — für Meldungen auf der Kommandozeile.
 *
 * Erst relativ zum Inhaltsordner (das Werkzeug liegt darin und wird so von
 * selbst zu "werkzeug/…"), sonst relativ zum Werkzeug. Alles andere bleibt
 * absolut: ein Pfad mit "../.." wäre unlesbarer als der ganze.
 */
export function rel(absolutePath) {
  const target = path.resolve(absolutePath);
  for (const base of [current?.root, SYS.root]) {
    if (base && inside(target, base)) {
      const relative = path.relative(base, target);
      return relative === '' ? '.' : relative;
    }
  }
  return target;
}
