/**
 * npm run new
 *
 * Legt einen neuen Flyer an — Schritt für Schritt, ohne Vorwissen.
 *
 * Am Ende steht ein fertiger Ordner unter content/flyers/ mit allen
 * Dateien, die der Build erwartet.
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

import { resolveHome, rel } from './lib/paths.mjs';
import { loadConfig } from './lib/config.mjs';
import { loadContent } from './lib/content.mjs';
import { blank, color, heading, info, ok, runMain, warn } from './lib/log.mjs';
import { slugify } from './lib/slug.mjs';
import { sharedTemplate, languageTemplate } from './lib/flyer-neu.mjs';

export { slugify };


runMain(async () => {
  const home = resolveHome();
  const config = loadConfig({ home });
  const content = loadContent(config, { dirs: home });

  heading('Neuen Flyer anlegen');
  info(color.gray('    Mit Strg+C jederzeit abbrechen. Es wird erst ganz am Ende etwas geschrieben.'));
  blank();

  const rl = readline.createInterface({ input: stdin, output: stdout });

  try {
    // --- Titel ---
    let title = '';
    while (title === '') {
      title = (await rl.question('Titel des Flyers:\n> ')).trim();
      if (title === '') warn('Bitte einen Titel eingeben.');
    }

    // --- Sprache ---
    blank();
    const languages = config.activeLanguages;
    info('Sprache:');
    languages.forEach((language, index) => info(color.gray(`    ${index + 1}) ${language.label}`)));
    const languageAnswer = (await rl.question(`> [1-${languages.length}, Standard 1] `)).trim();
    const language = languages[Number(languageAnswer || '1') - 1] ?? languages[0];

    // --- Kategorie ---
    blank();
    const categories = [...content.categories.keys()].sort();
    let category = null;
    if (categories.length > 0) {
      info('Kategorie:');
      categories.forEach((slug, index) => {
        const label = content.categories.get(slug).languages[language.code]?.title ?? slug;
        info(color.gray(`    ${index + 1}) ${label}  (${slug})`));
      });
      const answer = (await rl.question(`> [1-${categories.length}] `)).trim();
      category = categories[Number(answer) - 1] ?? null;
      if (!category) warn('Keine gültige Auswahl — die Kategorie kann später in flyer.md ergänzt werden.');
    } else {
      warn('Es sind noch keine Kategorien angelegt.');
    }

    // --- Themen ---
    blank();
    const topics = [...content.topics.keys()].sort();
    let chosenTopics = [];
    if (topics.length > 0) {
      info('Themen (mehrere durch Komma trennen, leer lassen für keine):');
      info(color.gray(`    ${topics.join(', ')}`));
      const answer = (await rl.question('> ')).trim();
      chosenTopics = answer
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => topics.includes(entry));
    }

    // --- PDF ---
    blank();
    info('Pfad zur PDF-Datei (leer lassen, um sie später zu kopieren):');
    const pdfAnswer = (await rl.question('> ')).trim().replace(/^["']|["']$/g, '');
    let pdfSource = null;
    if (pdfAnswer !== '') {
      const candidate = path.resolve(pdfAnswer);
      if (!fs.existsSync(candidate)) warn(`Die Datei wurde nicht gefunden: ${candidate}`);
      else if (!candidate.toLowerCase().endsWith('.pdf')) warn('Das ist keine PDF-Datei.');
      else pdfSource = candidate;
    }

    // --- Zusammenfassen ---
    const slug = slugify(title);
    const nextId = Math.max(100, ...content.flyers.map((flyer) => flyer.id)) + 1;
    const dirName = `${nextId}-${slug}`;
    const target = path.join(home.flyers, dirName);

    if (slug === '') {
      warn('Aus dem Titel liess sich kein Kurzname bilden.');
      return 1;
    }
    if (fs.existsSync(target)) {
      warn(`Der Ordner ${rel(target)} gibt es bereits.`);
      return 1;
    }

    blank();
    heading('Zusammenfassung');
    info(`Titel:     ${title}`);
    info(`Nummer:    ${nextId}   ${color.gray('(bleibt dauerhaft — gedruckte QR-Codes verweisen darauf)')}`);
    info(`Ordner:    ${rel(target)}`);
    info(`Sprache:   ${language.label}`);
    info(`Kategorie: ${category ?? color.gray('(noch offen)')}`);
    info(`Themen:    ${chosenTopics.join(', ') || color.gray('(keine)')}`);
    info(`PDF:       ${pdfSource ? rel(pdfSource) : color.gray('(später kopieren)')}`);
    blank();

    const confirm = (await rl.question('So anlegen? [J/n] ')).trim().toLowerCase();
    if (confirm !== '' && confirm !== 'j' && confirm !== 'ja' && confirm !== 'y') {
      blank();
      info('Abgebrochen. Es wurde nichts angelegt.');
      blank();
      return 0;
    }

    // --- Anlegen ---
    fs.mkdirSync(target, { recursive: true });

    fs.writeFileSync(
      path.join(target, 'flyer.md'),
      sharedTemplate({ id: nextId, slug, category, topics: chosenTopics, currency: config.order.defaultCurrency }),
    );
    fs.writeFileSync(
      path.join(target, `flyer.${language.code}.md`),
      languageTemplate({ title }),
    );

    if (pdfSource) {
      fs.copyFileSync(pdfSource, path.join(target, `flyer.${language.code}.pdf`));
    }

    blank();
    ok(`Angelegt: ${rel(target)}`);
    blank();
    info('Nächste Schritte:');
    info(color.gray(`    1. ${rel(path.join(target, `flyer.${language.code}.md`))} öffnen und die Beschreibung ergänzen`));
    if (!pdfSource) {
      info(color.gray(`    2. Die PDF-Datei als flyer.${language.code}.pdf in den Ordner kopieren`));
      info(color.gray('    3. In flyer.md  status: draft  auf  status: published  ändern'));
      info(color.gray('    4. npm run check'));
    } else {
      info(color.gray('    2. In flyer.md  status: draft  auf  status: published  ändern'));
      info(color.gray('    3. npm run check'));
    }
    blank();
    return 0;
  } finally {
    rl.close();
  }
});
