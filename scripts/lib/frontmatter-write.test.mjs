/**
 * Schreiben in den Kopf einer Inhaltsdatei.
 *
 * Die Mitarbeiter bearbeiten dieselben Dateien im Texteditor. Ein Speichern
 * aus der Oberfläche, das Kommentare verwirft oder Zeilen umsortiert, macht
 * jeden Vergleich zweier Stände unlesbar — und damit die Kontrolle vor einer
 * Veröffentlichung wertlos.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { updateFrontmatter, writeMarkdownFile, ENTFERNEN, readMarkdownFile, ContentError } from './frontmatter.mjs';

/** Der Kopf eines echten Flyers, mit Kommentar und kompakter Schreibweise. */
const FLYER = [
  '---',
  'demo: true',
  'id: 108',
  'slug: lebensfragen',
  'category: lebensfragen',
  'topics:',
  '  - lebensfragen',
  '  - angst',
  'tags: [sinn, fragen]',
  'bible_refs:',
  '  - Prediger 3,11',
  'status: published',
  'date: 2026-01-15',
  'download: false',
  'cover:',
  '  page: 1',
  '  # Gefalteter Dreitafel-Flyer: das Titelblatt ist das rechte Drittel.',
  '  crop: { x: 0.6667, y: 0, width: 0.3333, height: 1 }',
  'order:',
  '  enabled: true',
  '  price: 0',
  '  currency: EUR',
  '  min_quantity: 1',
  '---',
  '',
  'Ein längerer Text zum Flyer.',
  '',
].join('\n');

const zeilen = (text) => text.split('\n');

test('Eine Runde ohne Änderung lässt die Datei byteweise gleich', () => {
  assert.equal(updateFrontmatter(FLYER, {}), FLYER);
});

test('Nur die eine Zeile ändert sich', () => {
  const neu = updateFrontmatter(FLYER, { status: 'draft' });
  const a = zeilen(FLYER);
  const b = zeilen(neu);
  assert.equal(a.length, b.length);
  const anders = a.map((z, i) => (z === b[i] ? null : i)).filter((i) => i !== null);
  assert.deepEqual(anders.map((i) => b[i]), ['status: draft']);
});

test('Ein Kommentar überlebt eine Änderung daneben', () => {
  const neu = updateFrontmatter(FLYER, { 'cover.page': 3 });
  assert.ok(neu.includes('  # Gefalteter Dreitafel-Flyer: das Titelblatt ist das rechte Drittel.'));
  assert.ok(neu.includes('  page: 3'));
});

test('Die kompakte Schreibweise bleibt kompakt', () => {
  const neu = updateFrontmatter(FLYER, { status: 'draft' });
  assert.ok(neu.includes('  crop: { x: 0.6667, y: 0, width: 0.3333, height: 1 }'));
});

test('Eine Liste in eckigen Klammern bleibt in eckigen Klammern', () => {
  const neu = updateFrontmatter(FLYER, { tags: ['sinn', 'zweifel'] });
  assert.ok(neu.includes('tags: [sinn, zweifel]'), neu);
});

test('Eine Liste über mehrere Zeilen bleibt über mehrere Zeilen', () => {
  const neu = updateFrontmatter(FLYER, { topics: ['hoffnung', 'trost'] });
  assert.ok(neu.includes('topics:\n  - hoffnung\n  - trost\n'), neu);
});

test('Die Reihenfolge der Angaben bleibt', () => {
  const neu = updateFrontmatter(FLYER, { status: 'draft', 'order.price': 2 });
  const schluessel = zeilen(neu)
    .filter((z) => /^[a-z_]+:/.test(z))
    .map((z) => z.split(':')[0]);
  assert.deepEqual(schluessel, [
    'demo', 'id', 'slug', 'category', 'topics', 'tags', 'bible_refs',
    'status', 'date', 'download', 'cover', 'order',
  ]);
});

test('Eine verschachtelte Angabe wird gefunden', () => {
  const neu = updateFrontmatter(FLYER, { 'order.min_quantity': 5 });
  assert.ok(neu.includes('  min_quantity: 5'));
  assert.equal(readMarkdownFile2(neu).data.order.min_quantity, 5);
});

test('Ein neuer Schlüssel kommt ans Ende des Kopfs', () => {
  const neu = updateFrontmatter(FLYER, { publish_date: '2026-12-24' });
  const kopf = neu.split('---')[1].trim().split('\n');
  assert.equal(kopf[kopf.length - 1], 'publish_date: 2026-12-24');
});

test('Ein neuer verschachtelter Schlüssel kommt an den Elternblock', () => {
  const neu = updateFrontmatter(FLYER, { 'order.max_quantity': 250 });
  assert.ok(neu.includes('  min_quantity: 1\n  max_quantity: 250\n'), neu);
  assert.equal(readMarkdownFile2(neu).data.order.max_quantity, 250);
});

test('Ein ganz neuer Elternblock wird angelegt', () => {
  const neu = updateFrontmatter('---\nid: 1\n---\n', { 'order.price': 3 });
  assert.equal(readMarkdownFile2(neu).data.order.price, 3);
});

test('Eine Angabe lässt sich entfernen', () => {
  const neu = updateFrontmatter(FLYER, { download: ENTFERNEN });
  assert.ok(!neu.includes('download:'));
  assert.equal(readMarkdownFile2(neu).data.download, undefined);
  // Und der Rest bleibt vollständig.
  assert.equal(readMarkdownFile2(neu).data.id, 108);
});

test('Ein Wert mit Doppelpunkt wird in Anführungszeichen gesetzt', () => {
  const neu = updateFrontmatter(FLYER, { category: 'Wer ist Jesus: der Weg' });
  assert.ok(neu.includes('category: "Wer ist Jesus: der Weg"'), neu);
  assert.equal(readMarkdownFile2(neu).data.category, 'Wer ist Jesus: der Weg');
});

test('Umlaute bleiben lesbar und zusammengesetzt', () => {
  const neu = updateFrontmatter(FLYER, { category: 'Über die Grösse' });
  assert.ok(neu.includes('category: Über die Grösse'), neu);
  assert.equal(readMarkdownFile2(neu).data.category, 'Über die Grösse'.normalize('NFC'));
});

test('Ein Wert, der wie ein Schlüsselwort aussieht, wird zitiert', () => {
  const neu = updateFrontmatter(FLYER, { category: 'no' });
  assert.ok(neu.includes('category: "no"'), neu);
  assert.equal(readMarkdownFile2(neu).data.category, 'no');
});

test('Ein Tabulator im Kopf wird abgelehnt', () => {
  const kaputt = '---\nid: 1\n\tslug: x\n---\n';
  assert.throws(() => updateFrontmatter(kaputt, { id: 2 }), ContentError);
});

test('Windows-Zeilenenden bleiben Windows-Zeilenenden', () => {
  const neu = updateFrontmatter(FLYER.replace(/\n/g, '\r\n'), { status: 'draft' });
  assert.ok(neu.includes('status: draft\r\n'));
  assert.ok(!/[^\r]\n/.test(neu));
});

test('Der Rumpf bleibt unberührt', () => {
  const neu = updateFrontmatter(FLYER, { status: 'draft' });
  assert.ok(neu.endsWith('Ein längerer Text zum Flyer.\n'));
});

test('Was sich nicht sicher ändern lässt, wird nicht geschrieben', () => {
  // Eine Zuordnung über mehrere Zeilen in geschweiften Klammern: hier lässt
  // sich zeilenweise nichts zuverlässig ersetzen.
  const kaputt = '---\nid: 1\ncover: {\n  page: 1\n}\n---\n';
  assert.throws(
    () => updateFrontmatter(kaputt, { 'cover.page': 3 }, { file: 'flyer.md' }),
    (err) => err instanceof ContentError && /von Hand bearbeiten/.test(err.hint),
  );
});

test('writeMarkdownFile schreibt die Datei und lässt bei einem Fehler alles stehen', () => {
  const ordner = fs.mkdtempSync(path.join(os.tmpdir(), 'biblia-fm-'));
  const datei = path.join(ordner, 'flyer.md');
  fs.writeFileSync(datei, FLYER);

  writeMarkdownFile(datei, { changes: { status: 'draft' } });
  assert.equal(readMarkdownFile(datei).data.status, 'draft');
  assert.ok(fs.readFileSync(datei, 'utf8').includes('# Gefalteter Dreitafel-Flyer'));

  const vorher = fs.readFileSync(datei, 'utf8');
  assert.throws(() => writeMarkdownFile(datei, { changes: { 'cover.crop.x': 1 } }));
  assert.equal(fs.readFileSync(datei, 'utf8'), vorher, 'nach einem Fehler steht die Datei unverändert da');

  // Keine temporären Reste.
  assert.deepEqual(fs.readdirSync(ordner), ['flyer.md']);
});

test('Der Rumpf lässt sich ersetzen, ohne den Kopf anzufassen', () => {
  const ordner = fs.mkdtempSync(path.join(os.tmpdir(), 'biblia-fm-'));
  const datei = path.join(ordner, 'flyer.de.md');
  fs.writeFileSync(datei, '---\ntitle: Hoffnung\n# bleibt\ndescription: Kurz.\n---\n\nAlt.\n');

  writeMarkdownFile(datei, { body: 'Neuer Text.\n\nZweiter Absatz.' });
  const text = fs.readFileSync(datei, 'utf8');
  assert.ok(text.includes('# bleibt'));
  assert.ok(text.includes('Neuer Text.\n\nZweiter Absatz.\n'));
  assert.ok(!text.includes('Alt.'));
  assert.equal(readMarkdownFile(datei).data.title, 'Hoffnung');
});

/** Liest einen Text wie readMarkdownFile, aber ohne Datei. */
function readMarkdownFile2(text) {
  const ordner = fs.mkdtempSync(path.join(os.tmpdir(), 'biblia-fm-lesen-'));
  const datei = path.join(ordner, 'x.md');
  fs.writeFileSync(datei, text);
  return readMarkdownFile(datei);
}

test('Was sich nicht ändert, wird nicht neu geschrieben', () => {
  // Der Assistent schickt beim Speichern immer alle Felder mit. Würde jedes
  // davon neu geschrieben, stünde in jedem Vergleich zweier Stände auch das,
  // was niemand angefasst hat — und "Römer 15,13" verlöre seine
  // Anführungszeichen, obwohl sich nichts geändert hat.
  const unveraendert = updateFrontmatter(FLYER, {
    status: 'published',
    'bible_refs': ['Prediger 3,11'],
    topics: ['lebensfragen', 'angst'],
    tags: ['sinn', 'fragen'],
    'order.price': 0,
    download: false,
  });
  assert.equal(unveraendert, FLYER);
});

test('Eine echte Änderung wird trotzdem geschrieben', () => {
  const neu = updateFrontmatter(FLYER, { status: 'published', download: true });
  assert.ok(neu.includes('download: true'));
  assert.ok(neu.includes('status: published'));
  assert.equal(zeilen(neu).length, zeilen(FLYER).length);
});

test('Eine andere Reihenfolge in einer Liste zählt als Änderung', () => {
  // Sie darf nicht stillschweigend verworfen werden — wer sie vornimmt,
  // meint sie auch.
  const neu = updateFrontmatter(FLYER, { topics: ['angst', 'lebensfragen'] });
  assert.ok(neu.includes('topics:\n  - angst\n  - lebensfragen\n'), neu);
});

test('Ein Datum bleibt ein Datum und wird nicht neu geschrieben', () => {
  assert.equal(updateFrontmatter(FLYER, { date: '2026-01-15' }), FLYER);
  assert.ok(updateFrontmatter(FLYER, { date: '2026-02-01' }).includes('date: 2026-02-01'));
});
