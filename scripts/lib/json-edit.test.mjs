/**
 * Einzelne Werte in config/site.json ändern.
 *
 * Die Datei ist von Hand geschrieben und in Abschnitte gegliedert. Ein
 * Speichern, das sie neu erzeugt, macht jeden Vergleich zweier Stände
 * unlesbar — und damit die Kontrolle vor einer Veröffentlichung wertlos.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { updateJsonValues, scanJson, JsonError } from './json-edit.mjs';

const SITE = `{
  "siteName": "Biblia",
  "tagline": {
    "de": "Christliche Schriften",
    "en": "Christian leaflets"
  },

  "baseUrl": "https://biblia.schaefchens.de/v3/",
  "canonicalDomain": "biblia.at",

  "languages": [
    { "code": "de", "label": "Deutsch", "enabled": true },
    { "code": "it", "label": "Italiano", "enabled": false }
  ],

  "order": {
    "enabled": true,
    "defaultMaxQuantity": 100,
    "recipientEmail": "bestellung@example.invalid"
  },

  "retention": { "orderDays": 365, "contactDays": 180 }
}
`;

const zeilen = (text) => text.split('\n');

test('Jeder Wert wird im Text gefunden', () => {
  const orte = scanJson(SITE);
  assert.ok(orte.has('siteName'));
  assert.ok(orte.has('tagline.de'));
  assert.ok(orte.has('languages.1.enabled'));
  assert.ok(orte.has('order.recipientEmail'));
  assert.ok(orte.has('retention.orderDays'));
  const { start, end } = orte.get('siteName');
  assert.equal(SITE.slice(start, end), '"Biblia"');
});

test('Nur die eine Zeile ändert sich', () => {
  const neu = updateJsonValues(SITE, { 'order.recipientEmail': 'bestellung@biblia.at' });
  const a = zeilen(SITE);
  const b = zeilen(neu);
  assert.equal(a.length, b.length);
  const anders = a.map((z, i) => (z === b[i] ? null : i)).filter((i) => i !== null);
  assert.equal(anders.length, 1);
  assert.match(b[anders[0]], /bestellung@biblia\.at/);
});

test('Die Leerzeilen zwischen den Abschnitten bleiben', () => {
  const neu = updateJsonValues(SITE, { baseUrl: 'https://biblia.at/' });
  assert.equal(zeilen(SITE).filter((z) => z.trim() === '').length,
               zeilen(neu).filter((z) => z.trim() === '').length);
});

test('Ein Eintrag in einer Liste lässt sich ändern', () => {
  const neu = updateJsonValues(SITE, { 'languages.1.enabled': true });
  assert.equal(JSON.parse(neu).languages[1].enabled, true);
  assert.equal(JSON.parse(neu).languages[0].enabled, true);
  // Die kompakte Schreibweise der Zeile bleibt erhalten.
  assert.ok(neu.includes('{ "code": "it", "label": "Italiano", "enabled": true }'), neu);
});

test('Was sich nicht ändert, wird nicht neu geschrieben', () => {
  assert.equal(updateJsonValues(SITE, { siteName: 'Biblia', 'retention.orderDays': 365 }), SITE);
  assert.equal(updateJsonValues(SITE, {}), SITE);
});

test('Ein ganzes Objekt lässt sich ersetzen', () => {
  const neu = updateJsonValues(SITE, { tagline: { de: 'Neu', en: 'New' } });
  assert.deepEqual(JSON.parse(neu).tagline, { de: 'Neu', en: 'New' });
  assert.equal(JSON.parse(neu).siteName, 'Biblia');
});

test('Eine Angabe, die es nicht gibt, wird nicht angelegt', () => {
  assert.throws(
    () => updateJsonValues(SITE, { gibtsNicht: 1 }),
    (err) => err instanceof JsonError && /gibt es in dieser Datei nicht/.test(err.message),
  );
});

test('Sonderzeichen werden richtig geschrieben', () => {
  const neu = updateJsonValues(SITE, { siteName: 'Über "Hoffnung"' });
  assert.equal(JSON.parse(neu).siteName, 'Über "Hoffnung"');
});

test('Eine kaputte Datei wird nicht angefasst', () => {
  assert.throws(
    () => updateJsonValues('{ "a": 1, }', { a: 2 }),
    (err) => err instanceof JsonError && /kein gültiges JSON/.test(err.message),
  );
});

test('Alles andere bleibt Zeichen für Zeichen gleich', () => {
  const neu = updateJsonValues(SITE, { 'retention.contactDays': 90 });
  const ohne = (text) => text.replace(/"contactDays": \d+/, '"contactDays": X');
  assert.equal(ohne(neu), ohne(SITE));
});
