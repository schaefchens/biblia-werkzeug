/**
 * Liest das Verzeichnis content/ ein und prüft es.
 *
 * Bricht bewusst nicht beim ersten Problem ab, sondern sammelt alles in einer
 * Issues-Liste. npm run check gibt sie aus, npm run build bricht nur bei
 * echten Fehlern ab und überspringt einzelne fehlerhafte Flyer.
 */
import fs from 'node:fs';
import path from 'node:path';
import { rel } from './paths.mjs';
import { readMarkdownFile, ContentError } from './frontmatter.mjs';
import { Issues } from './issues.mjs';
import { renderMarkdown, markdownToPlainText, truncate } from './markdown.mjs';
import { SLUG, FLYER_DIR } from './slug.mjs';

const STATUS = ['draft', 'published', 'archived'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const CURRENCY = /^[A-Z]{3}$/;

/** Obergrenze für jede Mengenangabe — schützt auch den PHP-Endpunkt. */
export const MAX_ORDER_QUANTITY = 1000;

/** Verzeichnisse alphabetisch — sorgt für reproduzierbare Builds. */
function listDirectories(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort();
}

function listFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort();
}

/** Gibt es diesen Tag wirklich? Fängt 2026-02-30 und 2026-13-01 ab. */
function isRealDate(text) {
  const [year, month, day] = text.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

/**
 * Ein Datum als Text, oder null. YAML wandelt Datumsangaben in Date-Objekte um.
 *
 * Ein unlesbares Datum ist ein Fehler und kein stillschweigend übernommener
 * Text: es steht in der Sitemap, bestimmt die Reihenfolge im Archiv und
 * entscheidet bei publish_date darüber, ob ein Flyer schon sichtbar ist.
 */
function readDate(value, { subject, field, file, issues }) {
  if (value === null || value === undefined || value === '') return null;

  let text;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      issues.error(subject, `Die Angabe "${field}" ist kein gültiges Datum.`, {
        file,
        hint: 'Erwartet wird ein Datum der Form 2026-08-14.',
      });
      return null;
    }
    // Immer als UTC lesen, sonst verschiebt sich das Datum je nach Zeitzone
    // des Rechners um einen Tag.
    text = value.toISOString().slice(0, 10);
  } else {
    text = String(value).trim();
  }

  if (!DATE.test(text) || !isRealDate(text)) {
    issues.error(subject, `Die Angabe "${field}" ist kein gültiges Datum: ${JSON.stringify(value)}`, {
      file,
      hint: 'Erwartet wird ein Datum der Form 2026-08-14 (Jahr-Monat-Tag).',
    });
    return null;
  }
  return text;
}

/** Wert als Liste von Texten, egal ob einzeln oder als Liste geschrieben. */
function toList(value) {
  if (value === null || value === undefined || value === '') return [];
  const list = Array.isArray(value) ? value : [value];
  return list.map((v) => String(v).trim().normalize('NFC')).filter(Boolean);
}

/**
 * Liest Dateien der Form <name>.md und <name>.<lang>.md aus einem Verzeichnis.
 * @returns {{ shared: object|null, byLanguage: Map<string, object> }}
 */
function readLanguageSet(dir, baseName, languageCodes, issues, subject) {
  const shared = { data: {}, body: '', file: path.join(dir, `${baseName}.md`) };
  const byLanguage = new Map();

  const sharedPath = path.join(dir, `${baseName}.md`);
  let sharedFound = false;
  if (fs.existsSync(sharedPath)) {
    try {
      Object.assign(shared, readMarkdownFile(sharedPath));
      sharedFound = true;
    } catch (err) {
      if (err instanceof ContentError) issues.fromContentError(subject, err);
      else throw err;
    }
  }

  // Sprachdateien einlesen. Unbekannte Sprachen werden gemeldet, damit ein
  // Tippfehler im Dateinamen nicht als "fehlende Übersetzung" untergeht.
  const pattern = new RegExp(`^${baseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.([a-z]{2})\\.md$`);
  for (const name of listFiles(dir)) {
    const match = pattern.exec(name);
    if (!match) continue;
    const lang = match[1];
    const file = path.join(dir, name);
    if (!languageCodes.includes(lang)) {
      issues.warning(subject, `Die Datei ${name} gehört zu keiner aktiven Sprache.`, {
        file,
        hint: `Aktive Sprachen: ${languageCodes.join(', ')}. Tippfehler im Dateinamen?`,
      });
      continue;
    }
    try {
      byLanguage.set(lang, readMarkdownFile(file));
    } catch (err) {
      if (err instanceof ContentError) issues.fromContentError(subject, err);
      else throw err;
    }
  }

  return { shared, sharedFound, byLanguage };
}

/** Prüft die sprachneutralen Angaben eines Flyers. */
function readFlyerMeta(dirName, data, file, issues, config) {
  const subject = dirName;
  const match = FLYER_DIR.exec(dirName);
  if (!match) {
    issues.error(subject, `Der Ordnername "${dirName}" hat nicht die erwartete Form.`, {
      hint: 'Erwartet wird <Nummer>-<kurzname>, zum Beispiel 123-hoffnung.',
    });
    return null;
  }
  const [, dirId, dirSlug] = match;

  const id = Number(data.id);
  if (!Number.isInteger(id) || id <= 0) {
    issues.error(subject, 'Die Angabe "id" fehlt oder ist keine positive ganze Zahl.', { file, hint: `Erwartet:  id: ${dirId}` });
    return null;
  }
  if (String(id) !== dirId) {
    issues.error(subject, `Die id (${id}) passt nicht zum Ordnernamen (${dirId}).`, {
      file,
      hint: 'Die id darf niemals geändert werden — gedruckte QR-Codes verweisen darauf. Passe stattdessen den Ordnernamen an.',
    });
    return null;
  }

  const slug = String(data.slug ?? '').trim();
  if (!SLUG.test(slug)) {
    issues.error(subject, `Die Angabe "slug" fehlt oder enthält unerlaubte Zeichen: ${JSON.stringify(data.slug)}`, {
      file,
      hint: 'Erlaubt sind nur Kleinbuchstaben, Ziffern und Bindestriche. Keine Umlaute, keine Leerzeichen.',
    });
    return null;
  }
  if (slug !== dirSlug) {
    issues.error(subject, `Der slug ("${slug}") passt nicht zum Ordnernamen ("${dirSlug}").`, {
      file,
      hint: `Benenne den Ordner in ${dirId}-${slug} um. Der alte slug wird automatisch in slug_history eingetragen.`,
    });
    return null;
  }

  const status = String(data.status ?? 'draft').trim().toLowerCase();
  if (!STATUS.includes(status)) {
    issues.error(subject, `Unbekannter Status: ${JSON.stringify(data.status)}`, {
      file,
      hint: `Erlaubt sind: ${STATUS.join(', ')}.`,
    });
  }

  const slugHistory = toList(data.slug_history).filter((s) => {
    if (SLUG.test(s)) return true;
    issues.warning(subject, `Ungültiger Eintrag in slug_history: ${JSON.stringify(s)}`, { file });
    return false;
  });
  if (slugHistory.includes(slug)) {
    issues.warning(subject, 'Der aktuelle slug steht auch in slug_history.', {
      file,
      hint: 'Das erzeugt eine Weiterleitung auf sich selbst. Den Eintrag entfernen.',
    });
  }

  const orderRaw = data.order ?? {};
  const price = Number(orderRaw.price ?? 0);
  if (!Number.isFinite(price) || price < 0) {
    issues.error(subject, `Ungültiger Preis: ${JSON.stringify(orderRaw.price)}`, { file });
  }

  const currency = String(orderRaw.currency ?? config.order.defaultCurrency).trim().toUpperCase();
  if (!CURRENCY.test(currency)) {
    issues.error(subject, `Ungültige Währung: ${JSON.stringify(orderRaw.currency)}`, {
      file,
      hint: 'Erwartet wird ein dreibuchstabiger Code wie EUR oder CHF.',
    });
  }

  // Mengenangaben. Sie begrenzen später auch den PHP-Endpunkt — eine
  // unsinnige Angabe hier wäre dort eine offene Tür.
  const quantity = (raw, key, fallback) => {
    if (raw === null || raw === undefined) return fallback;
    if (!Number.isInteger(raw) || raw < 1 || raw > MAX_ORDER_QUANTITY) {
      issues.error(subject, `Ungültige Angabe "order.${key}": ${JSON.stringify(raw)}`, {
        file,
        hint: `Erwartet wird eine ganze Zahl zwischen 1 und ${MAX_ORDER_QUANTITY}.`,
      });
      return fallback;
    }
    return raw;
  };
  const minQuantity = quantity(orderRaw.min_quantity, 'min_quantity', 1);
  const maxQuantity = quantity(orderRaw.max_quantity, 'max_quantity', config.order.defaultMaxQuantity);
  if (minQuantity > maxQuantity) {
    issues.error(
      subject,
      `order.min_quantity (${minQuantity}) ist größer als order.max_quantity (${maxQuantity}).`,
      { file },
    );
  }

  const cover = data.cover ?? {};
  if (cover.crop) {
    const c = cover.crop;
    const ok = ['x', 'y', 'width', 'height'].every(
      (k) => typeof c[k] === 'number' && c[k] >= 0 && c[k] <= 1,
    );
    if (!ok) {
      issues.error(subject, 'Der Ausschnitt in "cover.crop" ist ungültig.', {
        file,
        hint: 'x, y, width und height sind Anteile zwischen 0 und 1, z. B. width: 0.34 für das rechte Drittel.',
      });
    }
  }

  return {
    id,
    slug,
    slugHistory,
    dirName,
    sourceFile: file,
    /** Beispielinhalt aus "npm run demo" — darf nie in die Veröffentlichung. */
    demo: data.demo === true,
    category: data.category ? String(data.category).trim() : null,
    topics: toList(data.topics),
    tags: toList(data.tags),
    bibleRefs: toList(data.bible_refs),
    featured: data.featured === true,
    featuredOrder: Number.isInteger(data.featured_order) ? data.featured_order : null,
    status: STATUS.includes(status) ? status : 'draft',
    date: readDate(data.date, { subject, field: 'date', file, issues }),
    publishDate: readDate(data.publish_date, { subject, field: 'publish_date', file, issues }),
    download: data.download === true,
    cover: {
      page: Number.isInteger(cover.page) && cover.page > 0 ? cover.page : 1,
      crop: cover.crop ?? null,
      image: cover.image ? String(cover.image) : null,
    },
    order: {
      enabled: orderRaw.enabled !== false && config.order.enabled,
      price: Number.isFinite(price) && price >= 0 ? price : 0,
      currency: CURRENCY.test(currency) ? currency : config.order.defaultCurrency,
      minQuantity,
      maxQuantity: Math.max(minQuantity, maxQuantity),
    },
  };
}

/** Liest einen einzelnen Flyer. */
function readFlyer(dirName, config, issues, dirs) {
  const dir = path.join(dirs.flyers, dirName);
  const subject = dirName;
  const languageCodes = config.languageCodes;

  const { shared, sharedFound, byLanguage } = readLanguageSet(dir, 'flyer', languageCodes, issues, subject);
  if (!sharedFound) {
    issues.error(subject, 'Die Datei flyer.md fehlt.', {
      file: path.join(dir, 'flyer.md'),
      hint: 'Sie enthält die sprachunabhängigen Angaben: id, slug, Kategorie, Status.',
    });
    return null;
  }

  const meta = readFlyerMeta(dirName, shared.data, shared.file, issues, config);
  if (!meta) return null;

  // PDF-Dateien je Sprache einsammeln.
  const pdfs = new Map();
  for (const name of listFiles(dir)) {
    const m = /^flyer\.([a-z]{2})\.pdf$/i.exec(name);
    if (!m) continue;
    const lang = m[1].toLowerCase();
    if (!languageCodes.includes(lang)) {
      issues.warning(subject, `Die Datei ${name} gehört zu keiner aktiven Sprache.`, {
        file: path.join(dir, name),
      });
      continue;
    }
    pdfs.set(lang, path.join(dir, name));
  }

  const languages = {};
  for (const lang of languageCodes) {
    const entry = byLanguage.get(lang);
    const pdf = pdfs.get(lang) ?? null;

    if (!entry) {
      if (pdf) {
        issues.warning(subject, `${lang.toUpperCase()}: PDF vorhanden, aber flyer.${lang}.md fehlt.`, {
          file: pdf,
          hint: `Lege content/flyers/${dirName}/flyer.${lang}.md mit title und description an.`,
        });
      }
      continue;
    }

    const title = String(entry.data.title ?? '').trim();
    if (!title) {
      issues.error(subject, `${lang.toUpperCase()}: Der Titel fehlt.`, {
        file: entry.file,
        hint: 'Erwartet wird im Kopf der Datei:  title: Hoffnung',
      });
      continue;
    }

    const description = String(entry.data.description ?? '').trim();
    if (!description) {
      issues.warning(subject, `${lang.toUpperCase()}: Die Beschreibung fehlt.`, {
        file: entry.file,
        hint: 'Sie erscheint in der Übersicht, in Suchmaschinen und beim Teilen.',
      });
    }

    // Aus gescannten PDFs lässt sich kein Text auslesen. Dann kann er als
    // flyer.<sprache>.txt danebengelegt werden und ersetzt die automatische
    // Fassung vollständig.
    const textFile = path.join(dir, `flyer.${lang}.txt`);
    let textOverride = null;
    if (fs.existsSync(textFile)) {
      textOverride = fs.readFileSync(textFile, 'utf8').normalize('NFC').trim();
      if (!textOverride) {
        issues.warning(subject, `${lang.toUpperCase()}: flyer.${lang}.txt ist leer.`, {
          file: textFile,
          hint: 'Entweder den Text eintragen oder die Datei löschen.',
        });
        textOverride = null;
      }
    }

    languages[lang] = {
      lang,
      title,
      description,
      keywords: toList(entry.data.keywords),
      body: entry.body,
      bodyHtml: renderMarkdown(entry.body, lang),
      bodyText: markdownToPlainText(entry.body, lang),
      textOverride,
      textFile: textOverride ? textFile : null,
      pdf,
      hasOwnPdf: Boolean(pdf),
      file: entry.file,
    };
  }

  const availableLanguages = Object.keys(languages);
  if (availableLanguages.length === 0) {
    issues.error(subject, 'Es gibt keine einzige Sprachdatei.', {
      hint: `Lege mindestens content/flyers/${dirName}/flyer.${config.defaultLanguage}.md an.`,
    });
    return null;
  }

  // Für den Lesemodus wird eine PDF gebraucht. Fehlt sie in einer Sprache,
  // greift die Standardsprache — das ist erlaubt, soll aber sichtbar sein.
  const fallbackPdfLang =
    pdfs.get(config.defaultLanguage) ? config.defaultLanguage : [...pdfs.keys()][0] ?? null;
  for (const lang of availableLanguages) {
    if (!languages[lang].pdf && fallbackPdfLang) {
      languages[lang].pdf = pdfs.get(fallbackPdfLang);
      languages[lang].pdfLanguage = fallbackPdfLang;
      issues.warning(subject, `${lang.toUpperCase()}: Kein eigenes PDF — es wird das ${fallbackPdfLang.toUpperCase()}-PDF verwendet.`, {
        hint: `Lege content/flyers/${dirName}/flyer.${lang}.pdf an, sobald die Übersetzung gesetzt ist.`,
      });
    } else if (languages[lang].pdf) {
      languages[lang].pdfLanguage = lang;
    }
  }

  if (pdfs.size === 0) {
    issues.error(subject, 'Es gibt keine einzige PDF-Datei.', {
      hint: `Kopiere die Druckdatei als content/flyers/${dirName}/flyer.${config.defaultLanguage}.pdf in den Ordner.`,
    });
    return null;
  }

  if (meta.download && pdfs.size === 0) {
    issues.error(subject, 'download ist aktiviert, aber es gibt keine PDF-Datei.', { file: shared.file });
  }

  if (meta.status === 'published' && !languages[config.defaultLanguage]) {
    issues.error(
      subject,
      `Der Flyer ist veröffentlicht, aber es fehlt die Standardsprache (${config.defaultLanguage.toUpperCase()}).`,
      { hint: `Lege content/flyers/${dirName}/flyer.${config.defaultLanguage}.md an oder setze status: draft.` },
    );
  }

  if (meta.publishDate && meta.publishDate > new Date().toISOString().slice(0, 10)) {
    issues.warning(subject, `Geplant für ${meta.publishDate} — erscheint erst beim nächsten Build nach diesem Datum.`, {
      file: shared.file,
      hint: 'Der Server veröffentlicht nichts von selbst. An dem Tag einmal npm run publish ausführen.',
    });
  }

  return {
    ...meta,
    // Das Kennzeichen kann in jeder der Dateien stehen.
    demo: meta.demo || [...byLanguage.values()].some((entry) => entry.data.demo === true),
    dir,
    languages,
    availableLanguages,
    pageCount: null, // wird von der Medien-Pipeline gefüllt
  };
}

/** Liest Themen oder Kategorien (gleicher Aufbau). */
function readTaxonomy(baseDir, kind, config, issues) {
  const items = new Map();
  if (!fs.existsSync(baseDir)) return items;

  const names = new Set();
  for (const file of listFiles(baseDir)) {
    const m = /^([a-z0-9-]+)(?:\.([a-z]{2}))?\.md$/.exec(file);
    if (m) names.add(m[1]);
  }

  for (const slug of [...names].sort()) {
    const subject = `${kind}/${slug}`;
    if (!SLUG.test(slug)) {
      issues.error(subject, `Der Dateiname "${slug}" enthält unerlaubte Zeichen.`, {
        hint: 'Erlaubt sind nur Kleinbuchstaben, Ziffern und Bindestriche.',
      });
      continue;
    }
    const { shared, byLanguage } = readLanguageSet(baseDir, slug, config.languageCodes, issues, subject);
    const languages = {};
    for (const [lang, entry] of byLanguage) {
      const title = String(entry.data.title ?? '').trim();
      if (!title) {
        issues.warning(subject, `${lang.toUpperCase()}: Der Titel fehlt.`, { file: entry.file });
        continue;
      }
      languages[lang] = {
        lang,
        title,
        description: String(entry.data.description ?? '').trim(),
        body: entry.body,
        bodyHtml: renderMarkdown(entry.body, lang),
        file: entry.file,
      };
    }
    if (Object.keys(languages).length === 0) {
      issues.warning(subject, 'Keine einzige Sprachdatei mit Titel.', {
        hint: `Lege ${rel(baseDir)}/${slug}.${config.defaultLanguage}.md mit  title:  an.`,
      });
    }
    items.set(slug, {
      slug,
      kind,
      demo:
        shared.data.demo === true ||
        [...byLanguage.values()].some((entry) => entry.data.demo === true),
      order: Number.isInteger(shared.data.order) ? shared.data.order : null,
      languages,
      flyers: [],
    });
  }
  return items;
}

/** Liest die redaktionellen Seiten (Startseite, Über uns, Impressum, Datenschutz). */
function readPages(config, issues, dirs) {
  const pages = new Map();
  if (!fs.existsSync(dirs.pages)) return pages;

  const names = new Set();
  for (const file of listFiles(dirs.pages)) {
    const m = /^([a-z0-9-]+)(?:\.([a-z]{2}))?\.md$/.exec(file);
    if (m) names.add(m[1]);
  }

  for (const name of [...names].sort()) {
    const subject = `Seite ${name}`;
    const { shared, byLanguage } = readLanguageSet(dirs.pages, name, config.languageCodes, issues, subject);
    const languages = {};
    for (const [lang, entry] of byLanguage) {
      languages[lang] = {
        lang,
        title: String(entry.data.title ?? '').trim(),
        description: String(entry.data.description ?? '').trim(),
        headline: String(entry.data.headline ?? '').trim(),
        intro: String(entry.data.intro ?? '').trim(),
        body: entry.body,
        bodyHtml: renderMarkdown(entry.body, lang),
        data: entry.data,
        file: entry.file,
      };
      if (name !== 'home' && !languages[lang].title) {
        issues.warning(subject, `${lang.toUpperCase()}: Der Titel fehlt.`, { file: entry.file });
      }
    }
    pages.set(name, {
      name,
      data: shared.data,
      demo:
        shared.data.demo === true ||
        [...byLanguage.values()].some((entry) => entry.data.demo === true),
      languages,
    });
  }
  return pages;
}

/** Sortierung: neueste zuerst, dann nach id — immer eindeutig und reproduzierbar. */
export function byDateDesc(a, b) {
  const da = a.date ?? '';
  const db = b.date ?? '';
  if (da !== db) return db.localeCompare(da);
  return b.id - a.id;
}

/**
 * Liest alle Inhalte ein.
 *
 * @param {object} config
 * @param {object} options
 * @param {object} options.dirs  Verzeichnisse des Inhaltsordners aus resolveHome().
 * @returns {{ flyers, flyersById, pages, topics, categories, issues }}
 */
export function loadContent(config, { dirs }) {
  const issues = new Issues();

  const categories = readTaxonomy(dirs.categories, 'kategorie', config, issues);
  const topics = readTaxonomy(dirs.topics, 'thema', config, issues);
  const pages = readPages(config, issues, dirs);

  const flyers = [];
  const byId = new Map();
  const bySlug = new Map();
  const historySlugs = new Map();

  for (const dirName of listDirectories(dirs.flyers)) {
    const flyer = readFlyer(dirName, config, issues, dirs);
    if (!flyer) continue;

    if (byId.has(flyer.id)) {
      issues.error(dirName, `Die id ${flyer.id} wird bereits von ${byId.get(flyer.id).dirName} verwendet.`, {
        hint: 'Jede id darf nur einmal vergeben werden — sie ist die dauerhafte Adresse des Flyers.',
      });
      continue;
    }
    if (bySlug.has(flyer.slug)) {
      issues.error(dirName, `Der slug "${flyer.slug}" wird bereits von ${bySlug.get(flyer.slug).dirName} verwendet.`);
      continue;
    }

    byId.set(flyer.id, flyer);
    bySlug.set(flyer.slug, flyer);
    for (const old of flyer.slugHistory) {
      if (historySlugs.has(old) && historySlugs.get(old) !== flyer.id) {
        issues.error(dirName, `Der frühere slug "${old}" wird auch von einem anderen Flyer beansprucht.`, {
          hint: 'Weiterleitungen müssen eindeutig sein. Entferne den Eintrag bei einem der beiden Flyer.',
        });
      }
      historySlugs.set(old, flyer.id);
    }
    flyers.push(flyer);
  }

  // Frühere slugs dürfen nicht mit aktuellen kollidieren.
  for (const [old, id] of historySlugs) {
    if (bySlug.has(old) && bySlug.get(old).id !== id) {
      issues.error(byId.get(id).dirName, `Der frühere slug "${old}" ist heute der slug von ${bySlug.get(old).dirName}.`, {
        hint: 'Die Weiterleitung würde die andere Seite überschreiben. Entferne den Eintrag aus slug_history.',
      });
    }
  }

  // Verweise auf Kategorien und Themen prüfen und Rückverweise aufbauen.
  for (const flyer of flyers) {
    if (!flyer.category) {
      issues.warning(flyer.dirName, 'Es ist keine Kategorie angegeben.', {
        file: flyer.sourceFile,
        hint: `Verfügbar: ${[...categories.keys()].join(', ') || '(noch keine angelegt)'}`,
      });
    } else if (!categories.has(flyer.category)) {
      issues.error(flyer.dirName, `Unbekannte Kategorie: "${flyer.category}"`, {
        file: flyer.sourceFile,
        hint: `Verfügbar: ${[...categories.keys()].join(', ') || '(noch keine angelegt)'}. Neue Kategorie: Datei in content/categories/ anlegen.`,
      });
    } else {
      categories.get(flyer.category).flyers.push(flyer);
    }

    for (const topic of flyer.topics) {
      if (!topics.has(topic)) {
        issues.error(flyer.dirName, `Unbekanntes Thema: "${topic}"`, {
          file: flyer.sourceFile,
          hint: `Verfügbar: ${[...topics.keys()].join(', ') || '(noch keine angelegt)'}. Neues Thema: Datei in content/topics/ anlegen.`,
        });
      } else {
        topics.get(topic).flyers.push(flyer);
      }
    }
  }

  flyers.sort(byDateDesc);
  for (const group of [...categories.values(), ...topics.values()]) {
    group.flyers.sort(byDateDesc);
  }

  return {
    flyers,
    flyersById: byId,
    flyersBySlug: bySlug,
    pages,
    topics,
    categories,
    issues,
    /** Wird dieser Flyer in dieser Sprache gelistet? */
    isListed,
    /** Hat dieser Flyer in dieser Sprache überhaupt eine Adresse? */
    isReachable,
    /** Erscheint dieser Flyer irgendwo — auch sprachneutral unter /f/ID/? */
    isPublic,
    /** Alle Flyer, die in einer Sprache tatsächlich ausgeliefert werden. */
    published: (lang) => flyers.filter((f) => isListed(f, lang)),
    /** Flyer, die zwar nicht gelistet, aber weiterhin erreichbar sind. */
    reachable: (lang) => flyers.filter((f) => isReachable(f, lang)),
  };
}

/** Liegt das Veröffentlichungsdatum in der Zukunft? */
export function isScheduled(flyer, today = new Date().toISOString().slice(0, 10)) {
  return Boolean(flyer.publishDate && flyer.publishDate > today);
}

/**
 * Sichtbarkeit — bewusst an genau einer Stelle.
 *
 * Jede Seite, die einen Flyer zeigt oder verlinkt, muss dieselbe Bedingung
 * verwenden. Sonst taucht ein geplanter Flyer zwar nicht im Archiv auf,
 * aber auf einer Themenseite oder unter der Kurzadresse — und ist damit
 * vorzeitig veröffentlicht.
 */

/** Wird gelistet: veröffentlicht, in dieser Sprache vorhanden, nicht geplant. */
export function isListed(flyer, lang) {
  return flyer.status === 'published' && Boolean(flyer.languages[lang]) && !isScheduled(flyer);
}

/** Bleibt erreichbar: auch archiviert, aber weder Entwurf noch geplant. */
export function isReachable(flyer, lang) {
  return flyer.status !== 'draft' && Boolean(flyer.languages[lang]) && !isScheduled(flyer);
}

/** Erreichbar in mindestens einer Sprache — Grundlage der Kurzadressen. */
export function isPublic(flyer) {
  return flyer.status !== 'draft' && !isScheduled(flyer);
}

/** Kurzinfo für die Flyer-Karte: "8 Seiten · Lebensfragen". */
export function flyerMeta(flyer, lang, content, labels) {
  const parts = [];
  if (flyer.pageCount) parts.push(labels.pages(flyer.pageCount));
  const category = flyer.category ? content.categories.get(flyer.category) : null;
  const categoryTitle = category?.languages[lang]?.title;
  if (categoryTitle) parts.push(categoryTitle);
  return parts;
}

export { truncate };
