/**
 * npm run check
 *
 * Prüft alle Inhalte und meldet in einem Durchgang, was zu korrigieren ist.
 * Fehler verhindern den Build, Hinweise nicht.
 *
 *   --strict   Hinweise wie Fehler behandeln
 *   --fix      Erkannte Umbenennungen automatisch in slug_history eintragen
 *
 * Was geprüft wird, steht in scripts/lib/check.mjs. Hier steht nur, wie das
 * Ergebnis aussieht — damit die Oberfläche des Redaktionsassistenten
 * dieselben Prüfungen benutzen kann und nicht versehentlich weniger.
 */
import { resolveHome, rel } from './lib/paths.mjs';
import { loadConfig } from './lib/config.mjs';
import { loadContent } from './lib/content.mjs';
import { loadI18n } from './lib/i18n.mjs';
import { checkContent } from './lib/check.mjs';
import { blank, color, formatBytes, heading, info, ok, warn, error, runMain, plural } from './lib/log.mjs';

const args = process.argv.slice(2);
const strict = args.includes('--strict');
const fix = args.includes('--fix');

/** Gibt eine Gruppe von Meldungen zu einem Betreff aus. */
function printGroup(subject, items) {
  blank();
  info(color.bold(subject));
  for (const item of items) {
    const mark = item.level === 'error' ? color.red('  ✗') : color.yellow('  ⚠');
    process.stdout.write(`${mark} ${item.message}\n`);
    if (item.file) {
      const where = item.line ? `${rel(item.file)}:${item.line}` : rel(item.file);
      process.stdout.write(color.gray(`      ${where}\n`));
    }
    if (item.hint) process.stdout.write(color.gray(`      ${item.hint}\n`));
  }
}

runMain(async () => {
  const home = resolveHome();
  const config = loadConfig({ home });

  heading('Biblia — Inhalte prüfen');

  // Oberflächentexte zuerst: ein fehlender Schlüssel bricht sonst erst
  // mitten im Build ab.
  loadI18n(config, { overrideDir: home.i18n });
  ok('Oberflächentexte vollständig');

  const content = loadContent(config, { dirs: home });
  const { issues, fixed, release, stats } = checkContent({ home, config, content, fix });

  for (const { dirName, oldSlug } of fixed) {
    ok(`${dirName}: früherer Name "${oldSlug}" in slug_history eingetragen`);
  }

  blank();
  ok(plural(stats.total, 'Flyer gefunden', 'Flyer gefunden'));
  ok(`${stats.complete} vollständig`);

  // Überblick je Sprache.
  for (const lang of stats.perLanguage) {
    const parts = [`${lang.published} veröffentlicht`];
    if (lang.drafts > 0) parts.push(`${lang.drafts} Entwurf`);
    if (lang.archived > 0) parts.push(`${lang.archived} archiviert`);
    info(color.gray(`    ${lang.label}: ${parts.join(', ')}`));
  }

  if (stats.scheduled > 0) {
    info(
      color.gray(
        `    ${plural(stats.scheduled, 'Flyer ist geplant', 'Flyer sind geplant')} und erscheint erst beim nächsten Build nach dem jeweiligen Datum.`,
      ),
    );
  }

  // Umfang der Druckausgaben, die mit hochgeladen werden.
  if (stats.downloads.count > 0) {
    info(
      color.gray(
        `    ${plural(stats.downloads.count, 'Flyer wird', 'Flyer werden')} zum Herunterladen angeboten — ${formatBytes(stats.downloads.bytes)} zusätzlicher Upload.`,
      ),
    );
  }

  if (stats.paid > 0) {
    blank();
    warn(`${plural(stats.paid, 'Flyer hat', 'Flyer haben')} einen Preis über 0 hinterlegt.`);
    info(
      color.gray(
        '    Sobald Geld verlangt wird, gelten die Informationspflichten des Fern- und Auswärtsgeschäfte-Gesetzes.',
      ),
    );
    info(color.gray('    Das ist vor der Veröffentlichung rechtlich zu klären.'));
  }

  if (stats.redirects > 0) {
    info(
      color.gray(
        `    ${plural(stats.redirects, 'frühere Adresse wird weitergeleitet', 'frühere Adressen werden weitergeleitet')}.`,
      ),
    );
  }

  // Freigabe für die endgültige Domain.
  blank();
  if (release.problems.length === 0) {
    ok(`Bereit für die endgültige Domain${config.isStaging ? '' : ` (${config.canonicalDomain})`}.`);
  } else if (release.level === 'warning') {
    warn(
      `${plural(release.problems.length, 'Punkt ist', 'Punkte sind')} vor dem Umzug auf ${config.canonicalDomain ?? 'die endgültige Domain'} zu erledigen.`,
    );
    info(color.gray('    Auf der Testadresse ist das in Ordnung — die Einzelheiten stehen unten.'));
  } else {
    error(
      `${plural(release.problems.length, 'Punkt verhindert', 'Punkte verhindern')} die Veröffentlichung unter ${config.canonicalDomain}.`,
    );
  }

  // Meldungen ausgeben.
  const groups = issues.groupedBySubject();
  if (groups.length > 0) {
    const anyErrors = issues.hasErrors;
    heading(anyErrors ? 'Fehler und Hinweise' : 'Hinweise');
    for (const [subject, items] of groups) printGroup(subject, items);
  }

  heading('Ergebnis');
  const errorCount = issues.errors.length;
  const warningCount = issues.warnings.length;

  if (errorCount === 0 && warningCount === 0) {
    ok('Alles in Ordnung.');
    info(color.gray('    Nächster Schritt:  npm run build'));
    blank();
    return 0;
  }

  if (errorCount > 0) {
    error(plural(errorCount, 'Fehler — diese Stellen müssen korrigiert werden', 'Fehler — diese Stellen müssen korrigiert werden'));
  }
  if (warningCount > 0) {
    warn(plural(warningCount, 'Hinweis', 'Hinweise'));
  }
  if (errorCount === 0) {
    blank();
    info(color.gray('    Die Website lässt sich trotzdem erzeugen:  npm run build'));
  }
  blank();
  return errorCount > 0 || (strict && warningCount > 0) ? 1 : 0;
});
