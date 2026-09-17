/**
 * npm run publish
 *
 * Der eine Befehl für den Alltag: prüfen, erzeugen, sichern, hochladen.
 *
 *   1. Inhalte prüfen
 *   2. Website erzeugen
 *   3. Änderungen in Git sichern und zum Remote schicken
 *   4. Auf den Server hochladen
 *
 * Git läuft im Hintergrund mit. Die Mitarbeiter müssen es nicht bedienen.
 *
 *   --dry-run     Nichts verändern
 *   --no-git      Ohne Sicherung in Git
 *   --message X   Eigener Text für die Sicherung
 */
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { SYS, WERKZEUG_DIR, resolveHome } from './lib/paths.mjs';
import { loadConfig } from './lib/config.mjs';
import { loadContent } from './lib/content.mjs';
import { applyReleaseChecks } from './lib/release.mjs';
import { parseSubmoduleStatus, describeSubmoduleState } from './lib/werkzeug.mjs';
import { isRepositoryRoot } from './lib/repo.mjs';
import { build } from './build.mjs';
import {
  blank, color, error, formatDuration, heading, info, ok, plural, runMain, step, warn, fail,
} from './lib/log.mjs';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const noGit = args.includes('--no-git');
const messageIndex = args.indexOf('--message');
const customMessage = messageIndex >= 0 ? args[messageIndex + 1] : null;

/**
 * Git im Inhaltsordner — nie im Werkzeug.
 *
 * Die Unterscheidung ist wesentlich: das Werkzeug ist ein eigenes
 * Repository, das als Submodul im Inhaltsordner liegt. Ohne ausdrückliches
 * Arbeitsverzeichnis würde hier dessen Versionsgeschichte gesichert statt
 * der Inhalte.
 */
function git(cwd, argv, { allowFailure = false, raw = false } = {}) {
  try {
    const output = execFileSync('git', argv, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    // raw: bei "git submodule status" trägt das führende Leerzeichen
    // Bedeutung — beschneiden würde die Aussage verlieren.
    return raw ? output : output.trim();
  } catch (err) {
    if (allowFailure) return null;
    throw err;
  }
}

/**
 * Sichert die Inhalte in Git.
 *
 * Wichtig: es wird niemals blind alles hinzugefügt. Unter app-data/ liegen
 * Namen und Postadressen — landen die einmal in der Versionsgeschichte,
 * bekommt man sie praktisch nicht mehr heraus.
 */
function commitChanges(home, summary) {
  const status = git(home.root, ['status', '--porcelain'], { allowFailure: true }) ?? '';
  const entries = status.split('\n').filter(Boolean);

  const personal = entries.filter((line) => /\sapp-data\//.test(` ${line.slice(3)}`) || line.slice(3).startsWith('app-data/'));
  if (personal.length > 0) {
    fail(
      'Unter app-data/ liegen Dateien, die Git sieht.',
      'Dort stehen Namen und Postadressen. Sie dürfen nicht ins Repository.\n' +
        '  Prüfe, ob "app-data/" in .gitignore steht, und führe dann aus:\n' +
        '      git rm -r --cached app-data',
    );
  }

  if (entries.length === 0) {
    info(color.gray('    Keine Änderungen zu sichern.'));
    return false;
  }

  if (dryRun) {
    info(color.gray(`    ${plural(entries.length, 'Änderung würde gesichert', 'Änderungen würden gesichert')}.`));
    return false;
  }

  // Ausdrücklich ohne werkzeug/: welcher Stand des Werkzeugs gelten soll,
  // entscheidet die Betreuung des Projekts — nicht ein Veröffentlichen
  // nebenbei. So kann ein versehentlich verschobenes Submodul nie
  // mitgesichert werden.
  git(home.root, ['add', '--', 'content', 'config', 'i18n', 'theme.css',
    'package.json', 'README.md', '.gitignore', '.gitattributes', 'sftp.env.example']);

  const staged = git(home.root, ['diff', '--cached', '--name-only'], { allowFailure: true }) ?? '';
  if (staged.trim() === '') {
    info(color.gray('    Keine Änderungen zu sichern.'));
    return false;
  }

  git(home.root, ['commit', '-m', customMessage ?? summary]);
  ok(`Gesichert: ${plural(staged.split('\n').filter(Boolean).length, 'Datei', 'Dateien')}`);
  return true;
}

/** Schickt die Sicherung zum Remote. */
function pushChanges(home) {
  const remotes = git(home.root, ['remote'], { allowFailure: true }) ?? '';
  if (remotes.trim() === '') {
    warn('Es ist kein Git-Remote eingerichtet — die Inhalte sind nur auf diesem Rechner gesichert.');
    info(color.gray('    Ein privates Repository verbinden:  git remote add origin <adresse>'));
    return;
  }
  if (dryRun) return;

  const branch = git(home.root, ['rev-parse', '--abbrev-ref', 'HEAD'], { allowFailure: true }) ?? 'main';
  const result = spawnSync('git', ['push', '--set-upstream', remotes.split('\n')[0], branch], {
    cwd: home.root,
    encoding: 'utf8',
  });
  if (result.status === 0) {
    ok('Sicherung zum Remote geschickt.');
  } else {
    warn('Die Sicherung konnte nicht zum Remote geschickt werden.');
    info(color.gray(`    ${(result.stderr ?? '').trim().split('\n').slice(-2).join(' ')}`));
    info(color.gray('    Das Hochladen der Website läuft trotzdem weiter.'));
  }
}

runMain(async () => {
  const started = Date.now();
  const home = resolveHome();
  const config = loadConfig({ home });

  heading('Biblia Veröffentlichung');
  if (dryRun) warn('Probelauf — es wird nichts verändert.');

  // --- 1. Prüfen ---
  step('Inhalte prüfen');
  const content = loadContent(config, { dirs: home });
  // Unter der endgültigen Domain zählen Beispielinhalte, Platzhalter im
  // Impressum und unzustellbare Adressen als Fehler. Was einmal
  // veröffentlicht ist, steht in Suchmaschinen und auf gedruckten Flyern.
  const release = applyReleaseChecks({ config, content });
  const errors = content.issues.errors;
  const warnings = content.issues.warnings;

  info(color.gray(`    ${plural(content.flyers.length, 'Flyer geprüft', 'Flyer geprüft')}`));
  if (release.level === 'error' && release.problems.length > 0) {
    blank();
    error(
      `${plural(release.problems.length, 'Punkt verhindert', 'Punkte verhindern')} die Veröffentlichung unter ${config.canonicalDomain}.`,
    );
    for (const problem of release.problems) {
      info(`${color.bold(problem.subject)}: ${problem.message}`);
      if (problem.hint) info(color.gray(`    ${problem.hint}`));
    }
    blank();
    info('Es wurde nichts verändert und nichts hochgeladen.');
    blank();
    return 1;
  }
  if (release.level === 'warning' && release.problems.length > 0) {
    info(
      color.gray(
        `    ${plural(release.problems.length, 'Punkt ist', 'Punkte sind')} vor dem Umzug auf die endgültige Domain zu erledigen — npm run check zeigt sie.`,
      ),
    );
  }
  if (errors.length > 0) {
    blank();
    error(plural(errors.length, 'Fehler im Inhalt', 'Fehler im Inhalt'));
    for (const issue of errors.slice(0, 5)) info(`${color.bold(issue.subject)}: ${issue.message}`);
    blank();
    info('Vollständige Liste mit:  npm run check');
    info('Es wurde nichts verändert und nichts hochgeladen.');
    blank();
    return 1;
  }
  if (warnings.length > 0) {
    info(color.gray(`    ${plural(warnings.length, 'Hinweis', 'Hinweise')} — Einzelheiten mit:  npm run check`));
  }

  // --- Stand des Werkzeugs ---
  //
  // Mit einem anderen Stand als festgehalten entstünde eine andere Website
  // als vorgesehen. Das ist der eine Fehler, den ein Submodul lautlos macht.
  const submodule = parseSubmoduleStatus(
    git(home.root, ['submodule', 'status', '--', WERKZEUG_DIR], { allowFailure: true, raw: true }),
  );
  if (submodule.state === 'moved' || submodule.state === 'conflict') {
    const described = describeSubmoduleState(submodule, { dir: WERKZEUG_DIR });
    blank();
    warn(described.message);
    if (described.hint) info(color.gray(`    ${described.hint}`));
  }

  // --- 2. Erzeugen ---
  blank();
  step('Statische Website wird erzeugt');
  const outcome = await build({ home, quiet: true });
  if (!outcome.ok) {
    blank();
    error('Die Website konnte nicht fehlerfrei erzeugt werden.');
    info('Einzelheiten mit:  npm run build');
    blank();
    return 1;
  }
  info(
    color.gray(
      `    ${plural(outcome.emitter.size, 'Datei', 'Dateien')}, davon ${outcome.result.written} neu oder geändert`,
    ),
  );

  // --- 3. Sichern ---
  blank();
  if (noGit) {
    info(color.gray('    Sicherung in Git übersprungen (--no-git).'));
  } else if (!isRepositoryRoot(home.root)) {
    warn('Der Inhaltsordner ist kein eigenes Git-Repository — es wird nichts gesichert.');
    info(color.gray(`    ${home.root}`));
  } else {
    step('Inhalte sichern');
    const summary = `Inhalte aktualisiert: ${content.flyers.length} Flyer`;
    commitChanges(home, summary);
    pushChanges(home);
  }

  // --- 4. Hochladen ---
  blank();
  step('Website wird hochgeladen');
  if (dryRun) {
    info(color.gray('    Übersprungen (Probelauf). Einzeln ausprobieren:  npm run deploy -- --dry-run'));
    blank();
    return 0;
  }

  // Absoluter Pfad und ausdrücklicher Inhaltsordner: das Werkzeug liegt
  // woanders als die Inhalte.
  const deploy = spawnSync(
    process.execPath,
    [path.join(SYS.scripts, 'deploy.mjs'), '--home', home.root],
    { cwd: home.root, stdio: 'inherit' },
  );

  blank();
  if (deploy.status !== 0) {
    error('Das Hochladen ist fehlgeschlagen.');
    info('Der Vorgang lässt sich gefahrlos wiederholen:  npm run deploy');
    blank();
    return 1;
  }

  heading('Fertig');
  ok(`${plural(content.flyers.length, 'Flyer', 'Flyer')} veröffentlicht in ${formatDuration(Date.now() - started)}.`);
  info(`    ${config.baseUrl}`);
  blank();
  return 0;
});
