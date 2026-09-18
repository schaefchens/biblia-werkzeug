/**
 * Liest Markdown-Dateien mit YAML-Kopf.
 *
 * YAML ist die häufigste Fehlerquelle für die Mitarbeiter. Deshalb werden
 * Fehler hier mit Datei, Zeilennummer und einem konkreten Hinweis gemeldet,
 * nicht als technische Ausnahme weitergereicht.
 */
import fs from 'node:fs';
import { load as loadYaml } from 'js-yaml';
import { rel } from './paths.mjs';

/** Fehler in einer Inhaltsdatei, mit Ort und Hilfestellung. */
export class ContentError extends Error {
  constructor({ file, line, message, hint }) {
    super(message);
    this.name = 'ContentError';
    this.file = file;
    this.line = line;
    this.hint = hint;
  }
  /** Einzeiler für die Ausgabe in npm run check. */
  get location() {
    return this.line ? `${rel(this.file)}:${this.line}` : rel(this.file);
  }
}

const FENCE = /^---\r?\n/;

/**
 * Häufige YAML-Stolperfallen in eine verständliche Erklärung übersetzen.
 * Die Meldungen von js-yaml sind für Nicht-Entwickler unbrauchbar.
 */
function explainYamlError(message, sourceLine, headerLines = []) {
  const text = (sourceLine ?? '').trim();

  // Ein unmaskierter Doppelpunkt im Wert ist der mit Abstand häufigste Fehler
  // ("title: Wer ist Jesus: der Weg"). js-yaml meldet dafür dasselbe wie für
  // echte Einrückungsfehler, deshalb wird hier die Quellzeile ausgewertet.
  const unquotedColon = /^([A-Za-z_][\w-]*)\s*:\s*(?!["'|>])(\S.*:.*)$/.exec(text);
  if (unquotedColon && /mapping values are not allowed|bad indentation/i.test(message)) {
    const [, key, value] = unquotedColon;
    return {
      message: 'Der Wert enthält einen Doppelpunkt und muss deshalb in Anführungszeichen stehen.',
      hint: `Schreibe stattdessen:  ${key}: "${value.trim()}"`,
    };
  }

  if (/mapping values are not allowed/i.test(message)) {
    return {
      message: 'An dieser Stelle ist ein Doppelpunkt nicht erlaubt.',
      hint: 'Werte, die einen Doppelpunkt enthalten, immer in "Anführungszeichen" setzen.',
    };
  }

  // Nicht geschlossenes Anführungszeichen — irgendwo im Kopf, nicht unbedingt
  // in der Zeile, die js-yaml meldet.
  const odd = (line, quote) => (line.match(new RegExp(quote, "g")) ?? []).length % 2 === 1;
  const unbalanced = [text, ...headerLines].find((line) => odd(line, '"') || odd(line, "'"));
  if (unbalanced) {
    return {
      message: 'Ein Anführungszeichen wurde geöffnet, aber nicht geschlossen.',
      hint: `Prüfe diese Zeile:  ${unbalanced.trim()}`,
      line: headerLines.indexOf(unbalanced) >= 0 ? headerLines.indexOf(unbalanced) + 2 : undefined,
    };
  }
  if (/duplicated mapping key/i.test(message)) {
    return {
      message: 'Dieser Eintrag kommt zweimal vor.',
      hint: 'Jeder Name darf im Kopf der Datei nur einmal stehen. Die zweite Zeile löschen.',
    };
  }
  if (/bad indentation|incomplete explicit mapping/i.test(message)) {
    return {
      message: 'Die Einrückung stimmt nicht.',
      hint: 'Immer Leerzeichen verwenden, niemals Tabulatoren, und untergeordnete Zeilen um zwei Leerzeichen einrücken.',
    };
  }
  if (/unexpected end of the stream|unexpected end of stream/i.test(message)) {
    return {
      message: 'Ein Anführungszeichen oder eine Klammer wurde nicht geschlossen.',
      hint: 'Prüfe, ob jedes " und jede [ auch wieder geschlossen wird.',
    };
  }
  if (/tab character/i.test(message)) {
    return {
      message: 'Die Datei enthält einen Tabulator.',
      hint: 'YAML erlaubt keine Tabulatoren. Ersetze sie durch Leerzeichen.',
    };
  }
  return { message: `Der Kopf der Datei konnte nicht gelesen werden: ${message}`, hint: null };
}

/**
 * Liest eine Markdown-Datei mit optionalem YAML-Kopf.
 * @returns {{ data: object, body: string, file: string }}
 */
export function readMarkdownFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    throw new ContentError({ file, message: 'Die Datei konnte nicht gelesen werden.' });
  }

  // macOS speichert Umlaute zerlegt, Windows und Linux zusammengesetzt.
  // Ohne Normalisierung sind identische Texte auf verschiedenen Rechnern
  // nicht gleich, was Suche, Vergleiche und den Zwischenspeicher stört.
  text = text.normalize('NFC').replace(/^\uFEFF/, '');

  if (!FENCE.test(text)) {
    return { data: {}, body: text.trim(), file };
  }

  const rest = text.replace(FENCE, '');
  const end = rest.search(/^---\s*$/m);
  if (end === -1) {
    throw new ContentError({
      file,
      line: 1,
      message: 'Der Kopf der Datei wurde nicht geschlossen.',
      hint: 'Nach den Angaben muss eine Zeile mit genau drei Bindestrichen folgen: ---',
    });
  }

  const header = rest.slice(0, end);
  const body = rest.slice(end).replace(/^---\s*\r?\n?/, '');

  let data;
  try {
    data = loadYaml(header, { filename: file }) ?? {};
  } catch (err) {
    const line = (err.mark?.line ?? 0) + 2; // +1 für die "---"-Zeile, +1 weil 0-basiert
    const sourceLine = header.split(/\r?\n/)[err.mark?.line ?? 0];
    const headerLines = header.split(/\r?\n/);
    const explained = explainYamlError(err.reason ?? err.message, sourceLine, headerLines);
    throw new ContentError({ file, line, ...explained, line: explained.line ?? line });
  }

  if (typeof data !== 'object' || Array.isArray(data)) {
    throw new ContentError({
      file,
      line: 2,
      message: 'Der Kopf der Datei muss aus Name-Wert-Paaren bestehen.',
      hint: 'Zum Beispiel:  title: Hoffnung',
    });
  }

  return { data, body: body.trim(), file };
}

/* ------------------------------------------------------------------ *
 * Schreiben
 *
 * Die Inhaltsdateien werden von Hand geschrieben und von Hand gelesen.
 * Sie enthalten Kommentare ("# Entwurf. Auf published setzen, sobald …"),
 * eine vom Autor gewählte Reihenfolge und Stellen, die bewusst kompakt
 * notiert sind (crop: { x: 0.6667, … }). Ein Umweg über die Ausgabe eines
 * YAML-Pakets würde all das bei jedem Speichern verwerfen: aus einer
 * geänderten Zeile würde eine neu geschriebene Datei.
 *
 * Deshalb wird hier nur die eine Stelle ersetzt, um die es geht — und
 * anschliessend geprüft, ob dabei versehentlich etwas anderes verrutscht
 * ist. Lässt sich das nicht sicher feststellen, wird nichts geschrieben.
 * ------------------------------------------------------------------ */

/** Wert für eine Angabe, die verschwinden soll. */
export const ENTFERNEN = Symbol('entfernen');

const STEUERZEICHEN = new RegExp('[\\t\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F]');
const YAML_WORT = /^(true|false|null|yes|no|on|off|~)$/i;
const ZAHL = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;
const NACKT = /^[A-Za-zÄÖÜäöüß0-9][A-Za-zÄÖÜäöüß0-9 .,_/()-]*$/;

const einzug = (zeile) => zeile.length - zeile.trimStart().length;

/** Ein Wert so, dass YAML ihn wieder genauso einliest. */
function alsYaml(wert, wo) {
  if (wert === null) return 'null';
  if (typeof wert === 'boolean') return wert ? 'true' : 'false';
  if (typeof wert === 'number') {
    if (!Number.isFinite(wert)) {
      throw new ContentError({ file: wo, message: `Die Angabe "${wert}" ist keine Zahl.` });
    }
    return String(wert);
  }
  const text = String(wert).normalize('NFC');
  if (STEUERZEICHEN.test(text)) {
    throw new ContentError({
      file: wo,
      message: 'Der Text enthält einen Tabulator oder ein Steuerzeichen.',
      hint: 'YAML erlaubt keine Tabulatoren. Bitte Leerzeichen verwenden.',
    });
  }
  if (text === '') return '""';
  const nackt = NACKT.test(text) && !YAML_WORT.test(text) && !ZAHL.test(text) && text === text.trim();
  return nackt ? text : JSON.stringify(text);
}

/** Zerlegt eine Datei in Kopf und Rumpf, ohne etwas zu verändern. */
function zerlege(text) {
  const eol = /\r\n/.test(text) ? '\r\n' : '\n';
  const normalisiert = text.normalize('NFC').replace(/^﻿/, '').replace(/\r\n/g, '\n');
  if (!FENCE.test(normalisiert)) {
    return { kopf: null, rumpf: normalisiert.trim(), eol };
  }
  const rest = normalisiert.replace(FENCE, '');
  const ende = rest.search(/^---\s*$/m);
  if (ende === -1) {
    return { kopf: null, rumpf: normalisiert.trim(), eol, unvollstaendig: true };
  }
  return {
    kopf: rest.slice(0, ende).replace(/\n$/, ''),
    rumpf: rest.slice(ende).replace(/^---\s*\n?/, '').trim(),
    eol,
  };
}

/**
 * Wo steht welche Angabe?
 *
 * Liefert je Zeile mit einem Schlüssel den Punktpfad, die Einrückung und die
 * Zeilennummer. Blockweise Texte (| und >) und Listeneinträge werden
 * übersprungen — dort steht kein Schlüssel, sondern Inhalt.
 */
function verzeichnis(zeilen) {
  const eintraege = [];
  const stapel = [];
  let blockBis = -1;

  zeilen.forEach((zeile, nummer) => {
    if (zeile.trim() === '' || zeile.trimStart().startsWith('#')) return;
    const tiefe = einzug(zeile);
    if (blockBis >= 0) {
      if (tiefe > blockBis) return;
      blockBis = -1;
    }
    const treffer = /^(\s*)([A-Za-z_][\w-]*)\s*:(.*)$/.exec(zeile);
    if (!treffer) return;
    const [, weiss, schluessel, rest] = treffer;
    while (stapel.length > 0 && stapel[stapel.length - 1].tiefe >= weiss.length) stapel.pop();
    const pfad = [...stapel.map((s) => s.schluessel), schluessel];
    eintraege.push({ pfad: pfad.join('.'), schluessel, tiefe: weiss.length, nummer, rest });
    if (/^\s*[|>]/.test(rest)) blockBis = weiss.length;
    else if (rest.trim() === '') stapel.push({ schluessel, tiefe: weiss.length });
  });

  return eintraege;
}

/** Von der Schlüsselzeile bis zum Ende ihres Werts. */
function bereich(zeilen, eintrag) {
  let ende = eintrag.nummer;
  for (let i = eintrag.nummer + 1; i < zeilen.length; i += 1) {
    if (zeilen[i].trim() === '' || einzug(zeilen[i]) > eintrag.tiefe) ende = i;
    else break;
  }
  while (ende > eintrag.nummer && zeilen[ende].trim() === '') ende -= 1;
  return { von: eintrag.nummer, bis: ende };
}

/** Die neuen Zeilen für eine Angabe. */
function zeilenFuer(schluessel, wert, tiefe, { flow = false, wo = null } = {}) {
  const weiss = ' '.repeat(tiefe);
  if (Array.isArray(wert)) {
    if (wert.length === 0) return [`${weiss}${schluessel}: []`];
    if (flow) return [`${weiss}${schluessel}: [${wert.map((v) => alsYaml(v, wo)).join(', ')}]`];
    return [`${weiss}${schluessel}:`, ...wert.map((v) => `${weiss}  - ${alsYaml(v, wo)}`)];
  }
  if (wert !== null && typeof wert === 'object' && !(wert instanceof Date)) {
    const paare = Object.entries(wert);
    if (paare.length === 0) return [`${weiss}${schluessel}: {}`];
    return [`${weiss}${schluessel}:`, ...paare.map(([k, v]) => `${weiss}  ${k}: ${alsYaml(v, wo)}`)];
  }
  return [`${weiss}${schluessel}: ${alsYaml(wert, wo)}`];
}

const istObjekt = (wert) =>
  wert !== null && typeof wert === 'object' && !Array.isArray(wert) && !(wert instanceof Date);

function hole(objekt, pfad) {
  let hier = objekt;
  for (const teil of pfad.split('.')) {
    if (!istObjekt(hier)) return undefined;
    hier = hier[teil];
  }
  return hier;
}

function loesche(objekt, pfad) {
  const teile = pfad.split('.');
  const kette = [objekt];
  let hier = objekt;
  for (const teil of teile.slice(0, -1)) {
    if (!istObjekt(hier)) return;
    hier = hier[teil];
    kette.push(hier);
  }
  if (!istObjekt(hier)) return;
  delete hier[teile[teile.length - 1]];

  // Eine Zwischenstufe, die dadurch leer wird, gibt es nur wegen dieser
  // Angabe. Bliebe sie stehen, sähe der Vergleich zweier Stände einen
  // Unterschied, wo keiner ist.
  for (let i = kette.length - 1; i > 0; i -= 1) {
    if (istObjekt(kette[i]) && Object.keys(kette[i]).length === 0) delete kette[i - 1][teile[i - 1]];
    else break;
  }
}

/** Tiefer Vergleich. Datumsangaben kommen aus YAML als Date-Objekt. */
function gleich(a, b) {
  if (a instanceof Date || b instanceof Date) {
    const alsText = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v);
    return alsText(a) === alsText(b);
  }
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

function unveraenderbar(wo, pfad) {
  throw new ContentError({
    file: wo,
    message: 'Der Kopf der Datei lässt sich nicht automatisch ändern.',
    hint:
      `Betroffene Angabe: ${pfad}\n` +
      '      Bitte die Datei von Hand bearbeiten. Es wurde nichts geschrieben.',
  });
}

/**
 * Ändert einzelne Angaben im Kopf, ohne den Rest anzufassen.
 *
 * Schlüssel sind Punktpfade: 'status', 'order.min_quantity', 'cover.page'.
 * Der Wert ENTFERNEN löscht die Angabe.
 *
 * @param {string} text  der vollständige Dateiinhalt
 * @param {object} changes
 * @param {object} [options]
 * @param {string} [options.file]  nur für Fehlermeldungen
 * @returns {string} der neue Dateiinhalt
 */
export function updateFrontmatter(text, changes, { file = null } = {}) {
  const { kopf, rumpf, eol, unvollstaendig } = zerlege(text);
  if (unvollstaendig) {
    throw new ContentError({
      file,
      line: 1,
      message: 'Der Kopf der Datei wurde nicht geschlossen.',
      hint: 'Nach den Angaben muss eine Zeile mit genau drei Bindestrichen folgen: ---',
    });
  }
  const eintraege = Object.entries(changes);
  if (eintraege.length === 0) return text;

  const zeilen = kopf === null ? [] : kopf.split('\n');
  if (zeilen.some((z) => z.includes('\t'))) {
    throw new ContentError({
      file,
      message: 'Die Datei enthält einen Tabulator.',
      hint: 'YAML erlaubt keine Tabulatoren. Ersetze sie durch Leerzeichen.',
    });
  }

  // Was ohnehin schon so dasteht, wird nicht angefasst.
  //
  // Ohne das schriebe jedes Speichern jede Angabe neu — auch die, die
  // niemand angerührt hat. Aus "Römer 15,13" würde Römer 15,13: gültig,
  // gleichbedeutend und trotzdem eine Zeile im Vergleich zweier Stände, die
  // niemand erklären kann.
  let vorstand;
  try {
    vorstand = (kopf === null ? {} : loadYaml(kopf)) ?? {};
  } catch {
    vorstand = {};
  }

  // Der Reihe nach, und jedes Mal neu nachsehen: eine Änderung verschiebt
  // die Zeilennummern aller folgenden.
  for (const [pfad, wert] of eintraege) {
    const bisher = hole(vorstand, pfad);
    if (wert === ENTFERNEN ? bisher === undefined : gleich(bisher, wert)) continue;
    const teile = pfad.split('.');
    const schluessel = teile[teile.length - 1];
    const verz = verzeichnis(zeilen);
    const treffer = verz.find((e) => e.pfad === pfad);

    if (treffer) {
      const { von, bis } = bereich(zeilen, treffer);
      if (wert === ENTFERNEN) {
        zeilen.splice(von, bis - von + 1);
        continue;
      }
      const flow = von === bis && /^\s*\[/.test(treffer.rest);
      zeilen.splice(von, bis - von + 1, ...zeilenFuer(schluessel, wert, treffer.tiefe, { flow, wo: file }));
      continue;
    }

    if (wert === ENTFERNEN) continue;

    if (teile.length === 1) {
      zeilen.push(...zeilenFuer(schluessel, wert, 0, { wo: file }));
      continue;
    }

    // Verschachtelt: als letztes Kind des vorhandenen Elternblocks.
    const elternPfad = teile.slice(0, -1).join('.');
    const eltern = verz.find((e) => e.pfad === elternPfad);
    if (!eltern) {
      if (teile.length > 2) unveraenderbar(file, pfad);
      zeilen.push(`${teile[0]}:`, ...zeilenFuer(schluessel, wert, 2, { wo: file }));
      continue;
    }
    if (eltern.rest.trim() !== '') unveraenderbar(file, pfad);
    const { bis } = bereich(zeilen, eltern);
    const kind = verz.find((e) => e.pfad.startsWith(`${elternPfad}.`) && e.tiefe > eltern.tiefe);
    const tiefe = kind ? kind.tiefe : eltern.tiefe + 2;
    zeilen.splice(bis + 1, 0, ...zeilenFuer(schluessel, wert, tiefe, { wo: file }));
  }

  const neuerKopf = zeilen.join('\n');

  // Gegenprobe: ist wirklich nur das anders, was anders sein sollte?
  let alt;
  let neu;
  try {
    alt = (kopf === null ? {} : loadYaml(kopf)) ?? {};
    neu = loadYaml(neuerKopf) ?? {};
  } catch {
    unveraenderbar(file, eintraege.map(([p]) => p).join(', '));
  }
  for (const [pfad, wert] of eintraege) {
    const jetzt = hole(neu, pfad);
    if (wert === ENTFERNEN) {
      if (jetzt !== undefined) unveraenderbar(file, pfad);
    } else if (!gleich(jetzt, wert)) {
      unveraenderbar(file, pfad);
    }
    loesche(alt, pfad);
    loesche(neu, pfad);
  }
  if (!gleich(alt, neu)) unveraenderbar(file, eintraege.map(([p]) => p).join(', '));

  const ergebnis = `---\n${neuerKopf}\n---\n${rumpf ? `\n${rumpf}\n` : ''}`;
  return eol === '\r\n' ? ergebnis.replace(/\n/g, '\r\n') : ergebnis;
}

/**
 * Schreibt eine Markdown-Datei mit geändertem Kopf und/oder Rumpf.
 *
 * Erst daneben, dann umbenennen: ein abgebrochener Schreibvorgang darf keine
 * halbe Datei hinterlassen.
 */
export function writeMarkdownFile(file, { changes = {}, body = undefined } = {}) {
  const vorher = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '---\n---\n';
  let text = Object.keys(changes).length > 0 ? updateFrontmatter(vorher, changes, { file }) : vorher;

  if (body !== undefined) {
    const { kopf, eol } = zerlege(text);
    const neuerRumpf = String(body).normalize('NFC').trim();
    text = `---\n${kopf ?? ''}\n---\n${neuerRumpf ? `\n${neuerRumpf}\n` : ''}`;
    if (eol === '\r\n') text = text.replace(/\n/g, '\r\n');
  }

  const temporaer = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  fs.writeFileSync(temporaer, text);
  fs.renameSync(temporaer, file);
  return text;
}
