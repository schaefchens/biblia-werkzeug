/**
 * Einzelne Werte in einer JSON-Datei ändern, ohne den Rest anzufassen.
 *
 * config/site.json ist von Hand geschrieben und in Abschnitte gegliedert.
 * Würde die Datei bei jedem Speichern neu erzeugt, verschwänden die
 * Leerzeilen dazwischen und jeder Vergleich zweier Stände zeigte die ganze
 * Datei — dasselbe Problem wie bei den Inhaltsdateien (siehe frontmatter.mjs).
 *
 * Deshalb wird nur der Textabschnitt ersetzt, in dem der Wert steht, und
 * anschliessend geprüft, ob wirklich nur das Beabsichtigte anders ist.
 */

/** Fehler in einer JSON-Datei, mit verständlicher Erklärung. */
export class JsonError extends Error {
  constructor(message, hint = null) {
    super(message);
    this.name = 'JsonError';
    this.hint = hint;
  }
}

/**
 * Wo steht welcher Wert?
 *
 * Liefert je Punktpfad die Anfangs- und Endstelle im Text. Listeneinträge
 * bekommen ihren Index als Pfadteil: "languages.1.enabled".
 */
export function scanJson(text) {
  const orte = new Map();
  let i = 0;

  const weiss = () => {
    while (i < text.length && ' \t\r\n'.includes(text[i])) i += 1;
  };

  function zeichenkette() {
    i += 1;
    while (i < text.length) {
      if (text[i] === '\\') { i += 2; continue; }
      if (text[i] === '"') { i += 1; return; }
      i += 1;
    }
    throw new JsonError('Eine Zeichenkette wurde nicht geschlossen.');
  }

  function skalar() {
    const start = i;
    while (i < text.length && !' \t\r\n,}]'.includes(text[i])) i += 1;
    if (i === start) throw new JsonError(`Unerwartetes Zeichen an Stelle ${start}.`);
  }

  function objekt(pfad) {
    i += 1;
    for (;;) {
      weiss();
      if (i >= text.length) throw new JsonError('Eine geschweifte Klammer wurde nicht geschlossen.');
      if (text[i] === '}') { i += 1; return; }
      if (text[i] === ',') { i += 1; continue; }
      if (text[i] !== '"') throw new JsonError(`Erwartet wurde ein Name an Stelle ${i}.`);
      const start = i;
      zeichenkette();
      const name = JSON.parse(text.slice(start, i));
      weiss();
      if (text[i] !== ':') throw new JsonError(`Erwartet wurde ein Doppelpunkt an Stelle ${i}.`);
      i += 1;
      wert(pfad ? `${pfad}.${name}` : name);
    }
  }

  function liste(pfad) {
    i += 1;
    let index = 0;
    for (;;) {
      weiss();
      if (i >= text.length) throw new JsonError('Eine eckige Klammer wurde nicht geschlossen.');
      if (text[i] === ']') { i += 1; return; }
      if (text[i] === ',') { i += 1; continue; }
      wert(pfad ? `${pfad}.${index}` : String(index));
      index += 1;
    }
  }

  function wert(pfad) {
    weiss();
    const start = i;
    const zeichen = text[i];
    if (zeichen === '{') objekt(pfad);
    else if (zeichen === '[') liste(pfad);
    else if (zeichen === '"') zeichenkette();
    else skalar();
    orte.set(pfad, { start, end: i });
  }

  wert('');
  return orte;
}

const istObjekt = (wert) => wert !== null && typeof wert === 'object' && !Array.isArray(wert);

function gleich(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => gleich(v, b[i]));
  }
  if (istObjekt(a) || istObjekt(b)) {
    if (!istObjekt(a) || !istObjekt(b)) return false;
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    return ka.length === kb.length && ka.every((k, i) => k === kb[i]) && ka.every((k) => gleich(a[k], b[k]));
  }
  return a === b;
}

function hole(objekt, pfad) {
  if (pfad === '') return objekt;
  let hier = objekt;
  for (const teil of pfad.split('.')) {
    if (hier === null || typeof hier !== 'object') return undefined;
    hier = hier[teil];
  }
  return hier;
}

function setze(objekt, pfad, wert) {
  const teile = pfad.split('.');
  let hier = objekt;
  for (const teil of teile.slice(0, -1)) hier = hier[teil];
  hier[teile[teile.length - 1]] = wert;
}

/**
 * Ändert einzelne Werte.
 *
 * @param {string} text  der vollständige Dateiinhalt
 * @param {object} changes  Punktpfad → neuer Wert
 * @returns {string} der neue Dateiinhalt
 */
export function updateJsonValues(text, changes) {
  const eintraege = Object.entries(changes);
  if (eintraege.length === 0) return text;

  let alt;
  try {
    alt = JSON.parse(text);
  } catch (err) {
    throw new JsonError(`Die Datei ist kein gültiges JSON: ${err.message}`,
      'Häufigste Ursachen: ein Komma zu viel vor einer schliessenden Klammer, oder ein fehlendes Anführungszeichen.');
  }

  const orte = scanJson(text);
  const zuAendern = [];
  for (const [pfad, wert] of eintraege) {
    if (!orte.has(pfad)) {
      throw new JsonError(`Die Angabe "${pfad}" gibt es in dieser Datei nicht.`,
        'Neue Angaben lassen sich hier nicht anlegen. Bitte die Datei von Hand bearbeiten.');
    }
    // Was ohnehin schon so dasteht, wird nicht angefasst — sonst stünde in
    // jedem Vergleich zweier Stände auch das, was niemand geändert hat.
    if (gleich(hole(alt, pfad), wert)) continue;
    zuAendern.push([pfad, wert]);
  }
  if (zuAendern.length === 0) return text;

  // Von hinten nach vorn ersetzen, damit die vorderen Stellen gültig bleiben.
  let neuerText = text;
  for (const [pfad, wert] of [...zuAendern].sort((a, b) => orte.get(b[0]).start - orte.get(a[0]).start)) {
    const { start, end } = orte.get(pfad);
    const eingerueckt = JSON.stringify(wert, null, 2)
      .split('\n')
      .map((zeile, nummer) => (nummer === 0 ? zeile : `${' '.repeat(einzugVon(text, start))}${zeile}`))
      .join('\n');
    neuerText = neuerText.slice(0, start) + eingerueckt + neuerText.slice(end);
  }

  // Gegenprobe: ist wirklich nur das anders, was anders sein sollte?
  let neu;
  try {
    neu = JSON.parse(neuerText);
  } catch (err) {
    throw new JsonError(`Die Änderung hätte die Datei unlesbar gemacht: ${err.message}`,
      'Es wurde nichts geschrieben.');
  }
  const erwartet = JSON.parse(JSON.stringify(alt));
  for (const [pfad, wert] of zuAendern) setze(erwartet, pfad, wert);
  if (!gleich(neu, erwartet)) {
    throw new JsonError('Die Änderung liess sich nicht sicher anwenden.',
      'Bitte die Datei von Hand bearbeiten. Es wurde nichts geschrieben.');
  }

  return neuerText;
}

/** Wie weit ist die Zeile eingerückt, in der diese Stelle steht? */
function einzugVon(text, stelle) {
  const zeilenanfang = text.lastIndexOf('\n', stelle - 1) + 1;
  const zeile = text.slice(zeilenanfang, stelle);
  return zeile.length - zeile.trimStart().length;
}
