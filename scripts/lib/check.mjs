/**
 * Die Prüfungen hinter "npm run check".
 *
 * Bewusst als eigenes Modul: drei dieser Prüfungen stehen nicht in
 * loadContent(), sondern lesen die Versionsgeschichte des Inhaltsordners —
 * und an ihnen hängen die beiden Zusagen, die dieses Projekt nach aussen
 * macht: dass eine einmal vergebene Nummer nie verschwindet (/f/123/ steht
 * auf gedruckten Flyern) und dass ein umbenannter Flyer eine Weiterleitung
 * bekommt.
 *
 * Solange sie im Rumpf von check.mjs standen, konnte sie niemand ausser der
 * Kommandozeile aufrufen. Eine zweite Oberfläche hätte damit stillschweigend
 * weniger geprüft als "npm run check" — und das ausgerechnet dort, wo ein
 * Fehler nicht auffällt: die Inhalte für sich sind ja widerspruchsfrei.
 *
 * check.mjs behält jede Zeile Ausgabe. Hier steht nur, was geprüft wird.
 */
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

import { isScheduled } from './content.mjs';
import { applyReleaseChecks } from './release.mjs';
import { parseRenames, parseHistoricIds, vanishedIds } from './history.mjs';
import { collectRedirects } from './redirects.mjs';
import { isRepositoryRoot } from './repo.mjs';

/**
 * Fragt Git im Inhaltsordner, oder liefert null.
 *
 * Ausdrücklich der Inhaltsordner: das Werkzeug unter werkzeug/ ist ein
 * eigenes Repository. Würde dessen Geschichte gelesen, fände sich dort
 * kein einziger Flyer — und die Prüfungen auf umbenannte und verschwundene
 * Nummern gingen lautlos ins Leere.
 */
export function gitInHome(home, argv) {
  try {
    return execFileSync('git', argv, {
      cwd: home.root,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

/**
 * Findet Flyer, deren Ordner umbenannt wurde.
 *
 * Ohne die Historie aus slug_history brechen geteilte Links und
 * Suchergebnisse, sobald jemand einen Titel ändert.
 */
function detectRenames(home, content, runGit) {
  if (!isRepositoryRoot(home.root)) return [];
  const output = runGit(home, ['log', '--diff-filter=R', '--name-status', '--format=', '-M', '--', 'content/flyers']);
  if (output === null) return [];

  const renames = [];
  for (const { oldId, oldSlug, newDir } of parseRenames(output)) {
    const flyer = content.flyers.find((f) => f.dirName === newDir);
    if (!flyer) continue;
    // Eine geänderte Nummer ist etwas anderes als ein geänderter Name: sie
    // steht in gedruckten QR-Codes und lässt sich nicht weiterleiten.
    if (oldId !== null && oldId !== flyer.id) {
      renames.push({ flyer, oldSlug, oldId });
      continue;
    }
    if (oldSlug === flyer.slug || flyer.slugHistory.includes(oldSlug)) continue;
    renames.push({ flyer, oldSlug, oldId: null });
  }
  return renames;
}

/**
 * Jede Nummer, die es in diesem Projekt je gegeben hat.
 *
 * Die Nummer ist die einzige Zusage, die dieses Projekt nach aussen macht:
 * /f/123/ steht auf gedruckten Flyern und muss jahrelang funktionieren.
 * Wird ein Ordner gelöscht oder umnummeriert, fällt das ohne diese Prüfung
 * niemandem auf — die Inhalte für sich sind dann ja widerspruchsfrei.
 */
export function historicFlyerIds(home, runGit = gitInHome) {
  // Ohne eigenes Repository würde Git im übergeordneten Ordner nachsehen
  // und eine leere Geschichte liefern — die Prüfung sähe dann bestanden aus.
  if (!isRepositoryRoot(home.root)) return null;
  const output = runGit(home, ['log', '--pretty=format:', '--name-only', '--', 'content/flyers']);
  return output === null ? null : parseHistoricIds(output);
}

/** Trägt einen früheren slug in flyer.md ein. */
function appendSlugHistory(flyer, oldSlug) {
  const text = fs.readFileSync(flyer.sourceFile, 'utf8');
  const updated = /^slug_history:/m.test(text)
    ? text.replace(/^slug_history:\s*(?:\[\s*\])?\s*$/m, `slug_history:\n  - ${oldSlug}`)
    : text.replace(/^(slug:.*)$/m, `$1\nslug_history:\n  - ${oldSlug}`);
  fs.writeFileSync(flyer.sourceFile, updated);
}

/** Umfang der Druckausgaben, die mit hochgeladen werden. */
function downloadBytes(flyers) {
  let bytes = 0;
  for (const flyer of flyers) {
    for (const lang of Object.values(flyer.languages)) {
      if (lang.hasOwnPdf && lang.pdf) bytes += fs.statSync(lang.pdf).size;
    }
  }
  return bytes;
}

/**
 * Prüft die Inhalte vollständig — einschliesslich der Prüfungen aus der
 * Versionsgeschichte. Ergänzt content.issues und gibt alles zurück, was die
 * Kommandozeile zur Ausgabe braucht.
 *
 * @param {object} options
 * @param {object} options.home     Verzeichnisse aus resolveHome()
 * @param {object} options.config   aus loadConfig()
 * @param {object} options.content  aus loadContent() — issues werden ergänzt
 * @param {boolean} [options.fix]   Erkannte Umbenennungen eintragen
 * @param {Function} [options.runGit] Nur für die Tests austauschbar
 */
export function checkContent({ home, config, content, fix = false, runGit = gitInHome }) {
  const { issues } = content;
  const fixed = [];

  // Umbenennungen erkennen.
  const renames = detectRenames(home, content, runGit);
  for (const { flyer, oldSlug, oldId } of renames) {
    if (oldId) {
      issues.error(flyer.dirName, `Die dauerhafte Nummer wurde von ${oldId} auf ${flyer.id} geändert.`, {
        file: flyer.sourceFile,
        hint:
          `Die Adresse /f/${oldId}/ steht auf gedruckten Flyern und ist damit unwiederbringlich kaputt.\n` +
          `      Benenne den Ordner zurück auf ${oldId}-${flyer.slug} und setze  id: ${oldId}.`,
      });
      continue;
    }
    if (fix) {
      appendSlugHistory(flyer, oldSlug);
      fixed.push({ dirName: flyer.dirName, oldSlug });
    } else {
      issues.warning(flyer.dirName, `Der Flyer hieß früher "${oldSlug}" — es fehlt eine Weiterleitung.`, {
        file: flyer.sourceFile,
        hint: 'Automatisch eintragen lassen mit:  npm run check -- --fix',
      });
    }
  }

  // Verschwundene Nummern erkennen.
  const historic = historicFlyerIds(home, runGit);
  const vanished = [];
  if (!historic) {
    // Ohne Versionsgeschichte lässt sich nicht feststellen, ob eine Nummer
    // verschwunden ist. Das still zu übergehen wäre das Gefährlichste:
    // die Zusage hinter /f/123/ wäre dann ungeprüft.
    issues.warning('Dauerhafte Adressen', 'Ohne Git lässt sich nicht prüfen, ob eine Nummer verschwunden ist.', {
      hint:
        'Die Adressen auf gedruckten Flyern sind damit ungeprüft.\n' +
        '      Der Inhaltsordner sollte ein Git-Repository sein:  git init',
    });
  }
  if (historic) {
    for (const id of vanishedIds(historic, content.flyersById, config.retiredFlyerIds)) {
      vanished.push(id);
      issues.error('Dauerhafte Adressen', `Die Nummer ${id} gab es schon einmal, heute gibt es sie nicht mehr.`, {
        hint:
          `Die Adresse /f/${id}/ liefert damit einen Fehler 404 — auch auf schon gedruckten Flyern.\n` +
          `      Einen Flyer aus dem Verkehr ziehen:  status: archived (die Adresse bleibt erreichbar).\n` +
          `      War die Nummer nie im Umlauf, in config/site.json eintragen:  "retiredFlyerIds": [${id}]`,
      });
    }
  }

  // Freigabe für die endgültige Domain.
  const release = applyReleaseChecks({ config, content });

  // Zahlen erst jetzt: "vollständig" zählt nur Flyer ohne eine der Meldungen
  // von oben.
  const total = content.flyers.length;
  const withProblems = new Set(issues.items.map((i) => i.subject));
  const complete = content.flyers.filter((f) => !withProblems.has(f.dirName)).length;

  const perLanguage = config.activeLanguages.map((lang) => ({
    code: lang.code,
    label: lang.label,
    published: content.published(lang.code).length,
    drafts: content.flyers.filter((f) => f.status === 'draft' && f.languages[lang.code]).length,
    archived: content.flyers.filter((f) => f.status === 'archived' && f.languages[lang.code]).length,
  }));

  const downloads = content.flyers.filter((f) => f.download);
  const paid = content.flyers.filter((f) => f.order.enabled && f.order.price > 0);

  return {
    issues,
    renames,
    fixed,
    historic,
    vanished,
    release,
    stats: {
      total,
      complete,
      perLanguage,
      scheduled: content.flyers.filter((f) => isScheduled(f)).length,
      downloads: { count: downloads.length, bytes: downloads.length > 0 ? downloadBytes(downloads) : 0 },
      paid: paid.length,
      redirects: collectRedirects({ config, content }).length,
    },
  };
}
