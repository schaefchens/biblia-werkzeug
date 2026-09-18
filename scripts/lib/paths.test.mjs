/**
 * Das Finden des Inhaltsordners.
 *
 * Seit Inhalte und Werkzeug getrennt sind, ist das die erste Frage jedes
 * Befehls — und die einzige, deren falsche Antwort still bleibt: ein
 * Werkzeug, das den falschen Ordner für den Inhaltsordner hält, baut
 * klaglos die falsche Website.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SYS, isHome, homeDirs, findHome, resolveHome, forgetHome, rel } from './paths.mjs';

/** Legt einen Ordner an, der als Inhaltsordner durchgeht. */
function makeHome(...nested) {
  const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'biblia-home-')), ...nested);
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  fs.writeFileSync(path.join(root, 'config', 'site.json'), '{}');
  return root;
}

const empty = () => fs.mkdtempSync(path.join(os.tmpdir(), 'biblia-leer-'));

test('Ein Ordner mit config/site.json ist ein Inhaltsordner', () => {
  assert.equal(isHome(makeHome()), true);
  assert.equal(isHome(empty()), false);
  assert.equal(isHome(null), false);
});

test('--home hat Vorrang vor allem anderen', () => {
  forgetHome();
  const chosen = makeHome();
  const other = makeHome();
  const found = findHome({ argv: ['--home', chosen], cwd: other, env: { BIBLIA_HOME: other } });
  assert.equal(found.root, chosen);
});

test('Ein falsches --home ist ein Fehler, keine stille Suche woanders', () => {
  forgetHome();
  const good = makeHome();
  assert.throws(
    () => findHome({ argv: ['--home', empty()], cwd: good, env: {} }),
    /kein Inhaltsordner/,
  );
});

test('BIBLIA_HOME gilt, wenn --home fehlt', () => {
  forgetHome();
  const chosen = makeHome();
  const found = findHome({ argv: [], cwd: empty(), env: { BIBLIA_HOME: chosen } });
  assert.equal(found.root, chosen);
});

test('Ein falsches BIBLIA_HOME wird gemeldet', () => {
  forgetHome();
  assert.throws(
    () => findHome({ argv: [], cwd: empty(), env: { BIBLIA_HOME: empty() } }),
    /BIBLIA_HOME zeigt auf keinen Inhaltsordner/,
  );
});

test('Sonst gilt das aktuelle Verzeichnis oder eines darüber', () => {
  forgetHome();
  const root = makeHome();
  const deep = path.join(root, 'content', 'flyers', '101-hoffnung');
  fs.mkdirSync(deep, { recursive: true });

  assert.equal(findHome({ argv: [], cwd: root, env: {} }).root, root);
  assert.equal(
    findHome({ argv: [], cwd: deep, env: {} }).root,
    root,
    'auch aus einem Unterordner heraus',
  );
});

test('Der nächstgelegene Inhaltsordner gewinnt', () => {
  forgetHome();
  const outer = makeHome();
  const inner = path.join(outer, 'zweiter');
  fs.mkdirSync(path.join(inner, 'config'), { recursive: true });
  fs.writeFileSync(path.join(inner, 'config', 'site.json'), '{}');

  assert.equal(findHome({ argv: [], cwd: inner, env: {} }).root, inner);
});

test('Ohne Inhaltsordner liefert findHome null', () => {
  forgetHome();
  // Ohne den Entwicklungs-Rückfall: beim Arbeiten am Werkzeug selbst liegt
  // dort ein Inhaltsordner, der den Test sonst je nach Rechner anders
  // ausgehen liesse.
  const nothing = { argv: [], cwd: empty(), env: {}, developmentFallback: false };
  assert.equal(findHome(nothing), null);
});

test('Der Entwicklungs-Rückfall gilt nur, wenn dort wirklich einer liegt', () => {
  forgetHome();
  const found = findHome({ argv: [], cwd: empty(), env: {} });
  if (found) {
    assert.equal(found.root, path.join(SYS.root, 'home'));
  } else {
    assert.equal(findHome({ argv: [], cwd: empty(), env: {}, developmentFallback: false }), null);
  }
});

test('resolveHome erklärt stattdessen, was zu tun ist', () => {
  forgetHome();
  const nothing = { argv: [], cwd: empty(), env: {}, developmentFallback: false };
  assert.throws(() => resolveHome(nothing), /Kein Inhaltsordner gefunden/);

  // Der Hinweis ist hier das Eigentliche: er nennt die beiden Wege weiter.
  try {
    resolveHome(nothing);
    assert.fail('resolveHome hätte abbrechen müssen');
  } catch (err) {
    assert.match(err.hint, /--recurse-submodules/);
    assert.match(err.hint, /init\.mjs/);
  }
});

test('Die Verzeichnisse liegen alle im Inhaltsordner', () => {
  const dirs = homeDirs('/irgendwo/inhalte');
  for (const [key, value] of Object.entries(dirs)) {
    assert.ok(
      value.startsWith('/irgendwo/inhalte'),
      `${key} zeigt aus dem Inhaltsordner heraus: ${value}`,
    );
  }
  assert.equal(dirs.flyers, path.join('/irgendwo/inhalte', 'content', 'flyers'));
  assert.equal(dirs.siteConfig, path.join('/irgendwo/inhalte', 'config', 'site.json'));
});

test('loadContent bekommt genau die Schlüssel, die es erwartet', () => {
  const dirs = homeDirs('/irgendwo/inhalte');
  for (const key of ['flyers', 'pages', 'topics', 'categories']) {
    assert.ok(key in dirs, `${key} fehlt`);
  }
});

test('Das Werkzeug liegt immer im Werkzeug', () => {
  assert.ok(SYS.scripts.startsWith(SYS.root));
  assert.ok(SYS.i18n.startsWith(SYS.root));
  assert.ok(SYS.server.startsWith(SYS.root));
});

test('rel() zeigt Pfade relativ zum Inhaltsordner', () => {
  forgetHome();
  const root = makeHome();
  findHome({ argv: ['--home', root], cwd: root, env: {} });

  assert.equal(rel(path.join(root, 'content', 'flyers', 'a')), path.join('content', 'flyers', 'a'));
  assert.equal(rel(root), '.');
  // Das Werkzeug liegt beim Entwickeln woanders — dann bleibt der Pfad ganz.
  assert.equal(rel('/ganz/woanders/datei.md'), '/ganz/woanders/datei.md');
  forgetHome();
});

test('rel() fällt auf das Werkzeug zurück, solange kein Inhaltsordner bekannt ist', () => {
  forgetHome();
  assert.equal(rel(path.join(SYS.root, 'scripts', 'build.mjs')), path.join('scripts', 'build.mjs'));
});

test('Das Werkzeug kennt keinen Pfad in den Redaktionsassistenten', () => {
  // Die Bedienoberfläche ist ein eigenes Repository und liegt als Submodul
  // unter assistant/. Bekäme SYS wieder einen Pfad dorthin, könnte ein Glob
  // im Build sie eines Tages mit auf den öffentlichen Server tragen — genau
  // der Fehler, gegen den die Trennung gebaut ist.
  const assistent = path.join(SYS.root, 'assistant');
  for (const [name, wert] of Object.entries(SYS)) {
    if (typeof wert !== 'string') continue;
    assert.ok(
      wert !== assistent && !wert.startsWith(assistent + path.sep),
      `SYS.${name} zeigt in den Assistenten: ${wert}`,
    );
  }
});
