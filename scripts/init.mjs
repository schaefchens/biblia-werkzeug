/**
 * node scripts/init.mjs <pfad>
 *
 * Legt einen neuen Inhaltsordner an.
 *
 * Das ist ein Befehl für die Projektbetreuung, kein täglicher. Mitarbeiter
 * bekommen einen fertigen Inhaltsordner mit
 *   git clone --recurse-submodules <adresse>
 *
 * Warum ein Befehl und keine Liste in einer Anleitung: zwei der Dateien
 * dulden keinen Fehler.
 *
 *   · .gitignore muss app-data/ und sftp.env aussperren. Fehlt eine Zeile,
 *     landen Namen, Postadressen und ein Passwort im Klartext in der
 *     Versionsgeschichte — von dort bekommt man sie praktisch nicht mehr weg.
 *   · .gitattributes muss Git LFS für PDFs einrichten, und zwar BEVOR die
 *     erste Druckdatei eingecheckt wird. Nachträglich ist das mühsam.
 *
 *   --werkzeug <adresse>  Andere Herkunft des Submoduls (auch ein lokaler Pfad)
 *   --name <name>         Name in der package.json
 *   --no-git              Kein git init, kein Submodul (für Versuche)
 *   --force               In einen vorhandenen, nicht leeren Ordner schreiben
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { SYS, WERKZEUG_DIR, isHome } from './lib/paths.mjs';
import { blank, color, heading, info, ok, runMain, step, warn, fail } from './lib/log.mjs';

/** Die öffentliche Adresse des Werkzeugs — bewusst https, nicht ssh. */
const DEFAULT_WERKZEUG = 'https://github.com/schaefchens/biblia-werkzeug.git';

/** Optionen, auf die ein Wert folgt. */
const WITH_VALUE = ['--werkzeug', '--name'];

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? null : null;
};

/** Das erste Argument, das weder Option noch Wert einer Option ist. */
function positional(argv) {
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (WITH_VALUE.includes(value)) {
      index += 1;
      continue;
    }
    if (!value.startsWith('--')) return value;
  }
  return null;
}

const target = positional(args);

function copyTemplate(name, to) {
  fs.copyFileSync(path.join(SYS.templates, 'home', name), to);
}

function git(cwd, argv) {
  execFileSync('git', argv, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Ist das ein Pfad auf diesem Rechner statt einer Adresse im Netz? */
const isLocalPath = (value) => !/^[a-z][a-z0-9+.-]*:\/\//i.test(value) && !value.includes('@');

/** Die aussagekräftigste Zeile aus einer Git-Fehlermeldung. */
function gitError(err) {
  const lines = String(err.stderr ?? err.message)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.find((line) => line.startsWith('fatal:') && !line.includes('clone of')) ?? lines[0] ?? '';
}

function gitWorks() {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

runMain(async () => {
  if (!target) {
    fail(
      'Es fehlt der Pfad für den neuen Inhaltsordner.',
      'Beispiel:  node scripts/init.mjs ~/Biblia-Inhalte',
    );
  }

  const root = path.resolve(target.replace(/^~(?=$|\/)/, process.env.HOME ?? '~'));
  const name = option('--name') ?? path.basename(root).toLowerCase().replace(/[^a-z0-9-]+/g, '-');
  const werkzeugUrl = option('--werkzeug') ?? DEFAULT_WERKZEUG;
  const withGit = !flag('--no-git');

  heading('Biblia — neuen Inhaltsordner anlegen');
  info(color.gray(`    ${root}`));
  blank();

  if (isHome(root)) {
    fail(
      `Dort liegt bereits ein Inhaltsordner: ${root}`,
      'Es wurde nichts verändert.',
    );
  }
  if (fs.existsSync(root) && fs.readdirSync(root).length > 0 && !flag('--force')) {
    fail(
      `Der Ordner ist nicht leer: ${root}`,
      'Wähle einen leeren Ordner, oder erzwinge es mit  --force.',
    );
  }

  // --- Gerüst ---
  step('Ordner und Dateien');
  for (const dir of ['content/flyers', 'content/pages', 'content/topics', 'content/categories', 'config']) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  }

  // Zuerst die beiden Dateien, bei denen ein Fehler teuer wäre.
  copyTemplate('gitignore', path.join(root, '.gitignore'));
  copyTemplate('gitattributes', path.join(root, '.gitattributes'));
  info(color.gray('    .gitignore       app-data/ und sftp.env ausgenommen'));
  info(color.gray('    .gitattributes   Git LFS für *.pdf'));

  copyTemplate('README.md', path.join(root, 'README.md'));
  copyTemplate('site.json', path.join(root, 'config', 'site.json'));

  const pkg = fs
    .readFileSync(path.join(SYS.templates, 'home', 'package.json'), 'utf8')
    .replace('__NAME__', name);
  fs.writeFileSync(path.join(root, 'package.json'), pkg);

  fs.copyFileSync(SYS.sftpEnvExample, path.join(root, 'sftp.env.example'));
  info(color.gray('    package.json, README.md, config/site.json, sftp.env.example'));

  // --- Git ---
  if (!withGit) {
    warn('Ohne Git angelegt (--no-git).');
  } else if (!gitWorks()) {
    warn('Git ist nicht installiert — der Ordner wurde ohne Repository angelegt.');
    info(color.gray('    Von https://git-scm.com installieren, danach im Inhaltsordner:  git init'));
  } else {
    blank();
    step('Git');
    git(root, ['init', '--quiet']);
    info(color.gray('    Repository angelegt'));

    try {
      git(root, ['lfs', 'install', '--local']);
      info(color.gray('    Git LFS aktiviert'));
    } catch {
      warn('Git LFS liess sich nicht aktivieren.');
      info(color.gray('    Von https://git-lfs.com installieren, danach:  git lfs install'));
    }

    // Git lehnt seit 2.38 Submodule aus lokalen Pfaden ab — eine Absicherung
    // gegen fremde Repositories, die beim Klonen etwas mitbringen. Hier hat
    // der Pfad aber ausdrücklich auf der Kommandozeile gestanden, ist also
    // eine bewusste Entscheidung. Die Ausnahme gilt nur für diesen einen
    // Aufruf und nur dann.
    const allowLocal = isLocalPath(werkzeugUrl) ? ['-c', 'protocol.file.allow=always'] : [];
    try {
      git(root, [...allowLocal, 'submodule', 'add', '--', werkzeugUrl, WERKZEUG_DIR]);
      info(color.gray(`    Werkzeug als Submodul: ${werkzeugUrl}`));
    } catch (err) {
      warn('Das Werkzeug liess sich nicht als Submodul hinzufügen.');
      info(color.gray(`    ${gitError(err)}`));
      info(color.gray(`    Von Hand:  git submodule add ${werkzeugUrl} ${WERKZEUG_DIR}`));
      info(color.gray('    Der Inhaltsordner ist trotzdem angelegt.'));
    }
  }

  // --- Nächste Schritte ---
  blank();
  ok('Inhaltsordner angelegt.');
  blank();
  info('Nächste Schritte:');
  info(color.gray(`    cd ${root}`));
  if (withGit) info(color.gray(`    npm run setup                  # Programmbibliotheken des Werkzeugs`));
  info(color.gray('    cp sftp.env.example sftp.env   # danach die Zugangsdaten eintragen'));
  info(color.gray('    # in config/site.json die baseUrl eintragen'));
  info(color.gray('    npm run demo                   # Beispielinhalte, zum Ausprobieren'));
  info(color.gray('    npm run doctor'));
  blank();
  info(color.gray('    Ein privates Repository verbinden:'));
  info(color.gray('        git remote add origin <adresse>'));
  blank();
  return 0;
});
