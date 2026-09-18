/**
 * Wie ein neuer Flyer aussieht.
 *
 * Eigenes Modul, damit "npm run new" und der Redaktionsassistent dieselbe
 * Datei anlegen. Die Kommentare darin sind kein Beiwerk: sie sind für viele
 * Mitarbeiter die einzige Anleitung, die sie beim Bearbeiten sehen.
 */

/** Text so schreiben, dass YAML ihn sicher wieder einliest. */
export function yamlValue(text) {
  return /^[A-Za-z0-9][A-Za-z0-9 .,_-]*$/.test(text) ? text : JSON.stringify(text);
}

/** Die sprachunabhängige flyer.md eines neuen Flyers. */
export function sharedTemplate({
  id,
  slug,
  category = null,
  topics = [],
  tags = [],
  bibleRefs = [],
  date = new Date().toISOString().slice(0, 10),
  currency = 'EUR',
  minQuantity = 1,
  maxQuantity = 100,
}) {
  const liste = (werte) =>
    werte.length > 0 ? `\n${werte.map((w) => `  - ${yamlValue(String(w))}`).join('\n')}\n` : ' []\n';

  let text = `---\nid: ${id}\nslug: ${slug}\n`;
  if (category) text += `category: ${category}\n`;
  if (topics.length > 0) text += `topics:${liste(topics)}`;
  text += `tags:${liste(tags)}`;
  text += `bible_refs:${liste(bibleRefs)}`;
  text += '# Entwurf. Auf "published" setzen, sobald der Flyer erscheinen soll.\n';
  text += 'status: draft\n';
  text += `date: ${date}\n`;
  text += 'featured: false\n';
  text += '# Auf true setzen, wenn die PDF-Datei zum Herunterladen angeboten werden soll.\n';
  text += 'download: false\n';
  text += `order:\n  enabled: true\n  price: 0\n  currency: ${currency}\n  min_quantity: ${minQuantity}\n  max_quantity: ${maxQuantity}\n`;
  text += '---\n';
  return text;
}

/** Die sprachabhängige flyer.<sprache>.md eines neuen Flyers. */
export function languageTemplate({ title, description = '', body = '' }) {
  const beschreibung = description
    ? `description: ${yamlValue(description)}\n`
    : 'description: ""   # Ein bis zwei Sätze. Erscheint in der Übersicht und beim Teilen.\n';
  const rumpf = body.trim()
    ? `${body.trim()}\n`
    : 'Hier kann ein längerer Text zum Flyer stehen. Er erscheint auf der Detailseite.\n';
  return `---\ntitle: ${yamlValue(title)}\n${beschreibung}---\n\n${rumpf}`;
}
