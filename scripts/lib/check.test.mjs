/**
 * Die Prüfungen, die die Versionsgeschichte lesen.
 *
 * Sie sind die einzigen, deren Ausfall still bleibt: die Inhalte für sich
 * sind auch dann widerspruchsfrei, wenn eine gedruckte Nummer ins Leere
 * zeigt. Deshalb wird hier nicht nur geprüft, dass sie melden, sondern auch,
 * dass sie überhaupt laufen.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { checkContent } from './check.mjs';
import { fixture, sharedFrontmatter } from './fixtures.helper.mjs';

/** Macht aus dem Fixture-Ordner ein echtes Repository — sonst greifen die
 *  Prüfungen nicht, und genau das wäre der stille Ausfall. */
function alsRepository(root) {
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  return root;
}

const gitVorhanden = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

/** Liefert feste Git-Ausgaben, damit die Auswertung prüfbar bleibt. */
function gitStub({ renames = '', historic = '' } = {}) {
  return (_home, argv) => (argv.includes('--diff-filter=R') ? renames : historic);
}

const einFlyer = (dirName = '101-hoffnung', extra = '') => ({
  dirName,
  shared: sharedFrontmatter({ id: Number(dirName.split('-')[0]), slug: dirName.split('-').slice(1).join('-'), extra }),
});

const meldungen = (issues) => issues.items.map((i) => `${i.level}: ${i.message}`).join('\n');

test('Ein umbenannter Flyer ohne Weiterleitung wird gemeldet', { skip: !gitVorhanden }, () => {
  const { config, content, dirs, root } = fixture([einFlyer()]);
  alsRepository(root);
  const { issues } = checkContent({
    home: { root, flyers: dirs.flyers },
    config,
    content,
    runGit: gitStub({
      renames: 'R100\tcontent/flyers/101-zuversicht/flyer.md\tcontent/flyers/101-hoffnung/flyer.md\n',
      historic: 'content/flyers/101-hoffnung/flyer.md\n',
    }),
  });
  const warnung = issues.warnings.find((i) => i.message.includes('zuversicht'));
  assert.ok(warnung, meldungen(issues));
  assert.match(warnung.hint, /npm run check -- --fix/);
});

test('Eine geänderte Nummer ist ein Fehler und nennt die kaputte Adresse', { skip: !gitVorhanden }, () => {
  const { config, content, dirs, root } = fixture([einFlyer('109-hoffnung')]);
  alsRepository(root);
  const { issues } = checkContent({
    home: { root, flyers: dirs.flyers },
    config,
    content,
    runGit: gitStub({
      renames: 'R100\tcontent/flyers/101-hoffnung/flyer.md\tcontent/flyers/109-hoffnung/flyer.md\n',
      historic: 'content/flyers/109-hoffnung/flyer.md\n',
    }),
  });
  const fehler = issues.errors.find((i) => i.message.includes('dauerhafte Nummer'));
  assert.ok(fehler, meldungen(issues));
  assert.match(fehler.hint, /\/f\/101\//);
});

test('Eine verschwundene Nummer wird gemeldet', { skip: !gitVorhanden }, () => {
  const { config, content, dirs, root } = fixture([einFlyer('102-gebet')], { topics: ['hoffnung'] });
  alsRepository(root);
  const { vanished, issues } = checkContent({
    home: { root, flyers: dirs.flyers },
    config,
    content,
    runGit: gitStub({
      historic: ['content/flyers/101-hoffnung/flyer.md', 'content/flyers/102-gebet/flyer.md'].join('\n'),
    }),
  });
  assert.deepEqual(vanished, [101]);
  assert.ok(issues.errors.some((i) => i.message.includes('Die Nummer 101')), meldungen(issues));
});

test('Eine zurückgezogene Nummer wird nicht gemeldet', { skip: !gitVorhanden }, () => {
  const { config, content, dirs, root } = fixture([einFlyer('102-gebet')], {
    site: { retiredFlyerIds: [101] },
  });
  alsRepository(root);
  const { vanished } = checkContent({
    home: { root, flyers: dirs.flyers },
    config,
    content,
    runGit: gitStub({
      historic: ['content/flyers/101-hoffnung/flyer.md', 'content/flyers/102-gebet/flyer.md'].join('\n'),
    }),
  });
  assert.deepEqual(vanished, []);
});

test('Ohne Git bleibt die Zusage hinter /f/123/ ungeprüft — und das wird gesagt', () => {
  // Kein git init: der Ordner ist bewusst kein Repository.
  const { config, content, dirs, root } = fixture([einFlyer()]);
  const { historic, issues } = checkContent({ home: { root, flyers: dirs.flyers }, config, content });
  assert.equal(historic, null);
  assert.ok(
    issues.warnings.some((i) => i.message.includes('Ohne Git lässt sich nicht prüfen')),
    meldungen(issues),
  );
});

test('--fix trägt den früheren Namen in slug_history ein', { skip: !gitVorhanden }, () => {
  const { config, content, dirs, root } = fixture([einFlyer()]);
  alsRepository(root);
  const { fixed, issues } = checkContent({
    home: { root, flyers: dirs.flyers },
    config,
    content,
    fix: true,
    runGit: gitStub({
      renames: 'R100\tcontent/flyers/101-zuversicht/flyer.md\tcontent/flyers/101-hoffnung/flyer.md\n',
      historic: 'content/flyers/101-hoffnung/flyer.md\n',
    }),
  });
  assert.deepEqual(fixed, [{ dirName: '101-hoffnung', oldSlug: 'zuversicht' }]);
  const text = fs.readFileSync(path.join(dirs.flyers, '101-hoffnung', 'flyer.md'), 'utf8');
  assert.match(text, /slug_history:\n {2}- zuversicht/);
  // Und es bleibt eine Meldung aus: eingetragen ist eingetragen.
  assert.ok(!issues.warnings.some((i) => i.message.includes('zuversicht')), meldungen(issues));
});

test('Die Zahlen sind die, die die Kommandozeile ausgibt', () => {
  const { config, content, dirs, root } = fixture([
    { ...einFlyer('101-hoffnung', 'download: true\n'), pdfs: ['de'] },
    // Von Hand: sharedFrontmatter() setzt status bereits, und ein zweiter
    // Eintrag desselben Schlüssels wäre kein Entwurf, sondern ein YAML-Fehler.
    { dirName: '102-gebet', shared: '---\nid: 102\nslug: gebet\ncategory: leben\nstatus: draft\n---\n' },
  ]);
  const { stats } = checkContent({ home: { root, flyers: dirs.flyers }, config, content });

  assert.equal(stats.total, 2);
  assert.equal(stats.downloads.count, 1);
  assert.ok(stats.downloads.bytes > 0, 'die Grösse der Druckausgabe wird mitgezählt');
  assert.equal(stats.paid, 0);

  const de = stats.perLanguage.find((l) => l.code === 'de');
  assert.equal(de.published, 1);
  assert.equal(de.drafts, 1);
  assert.equal(de.label, 'Deutsch');
});
