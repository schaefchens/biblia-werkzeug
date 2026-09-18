/**
 * Medien-Pipeline: aus PDF-Dateien werden alle Bilder der Website.
 *
 * Jeder Schritt hat einen eigenen Eintrag im Zwischenspeicher mit einem
 * eigenen Schlüssel. Dadurch führt eine Titeländerung nur dazu, dass die
 * Bilder zum Teilen neu entstehen — die aufwendig gerenderten Seiten
 * bleiben unberührt.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Cache, hashFile } from './cache.mjs';
import { renderPdf, renderPdfPage, PdfError } from './pdf.mjs';
import { createDerivatives } from './images.mjs';
import { createSocialImages, SOCIAL_TEMPLATE_VERSION } from './social.mjs';
import { html, attrs } from './html.mjs';

/** Zweistellige Seitennummer für stabile Dateinamen. */
const pageName = (index) => `page-${String(index).padStart(2, '0')}`;

/** srcset-Zeichenkette aus den erzeugten Breiten. */
function buildSrcset(sources, baseUrl) {
  return sources.map((entry) => `${baseUrl}/${entry.file} ${entry.width}w`).join(', ');
}

/**
 * Baut alle Medien und liefert ein Objekt, das die Vorlagen benutzen.
 *
 * @param {object} options
 * @param {object} options.config
 * @param {object} options.content
 * @param {object} options.i18n
 * @param {import('./emit.mjs').Emitter} options.emitter
 * @param {boolean} [options.force]  Zwischenspeicher übergehen
 * @param {string} options.cacheDir  Zwischenspeicher der Bilder
 * @param {string} options.printDir  Ziel für die Druck-QR-Codes
 * @param {(text:string)=>void} [options.onProgress]
 */
export async function buildMedia({
  config,
  content,
  i18n,
  emitter,
  force = false,
  cacheDir,
  printDir: printRoot,
  onProgress,
}) {
  const cache = new Cache(cacheDir, { disabled: force });
  const { images, share: shareConfig } = config;
  const byFlyer = new Map();
  const issues = [];
  let renderedPages = 0;

  /**
   * Innerhalb eines Laufs wird jede Druckdatei höchstens einmal verarbeitet.
   * Mehrere Sprachen können sich dieselbe PDF teilen; ohne diese Merkliste
   * würde sie bei --force mehrfach gezeichnet.
   */
  const pagesOnce = new Map();
  const coverOnce = new Map();
  const once = (store, key, produce) => {
    if (!store.has(key)) store.set(key, produce());
    return store.get(key);
  };

  /** Eine Datei nur einmal übernehmen — geteilte PDFs liefern dieselben Bilder. */
  const copyOnce = (target, source) => {
    if (!emitter.files.has(target)) emitter.copy(target, source);
  };

  const report = (level, flyer, message, extra = {}) =>
    issues.push({ level, subject: flyer.dirName, message, ...extra });

  for (const flyer of content.flyers) {
    for (const langCode of Object.keys(flyer.languages)) {
      const entry = flyer.languages[langCode];
      if (!entry.pdf) continue;

      // Liegt für diese Sprache kein eigenes PDF vor, wird das der
      // Standardsprache verwendet. Seiten und Titelbild sind dann dieselben
      // Dateien — nur die Bilder zum Teilen entstehen je Sprache neu, denn
      // sie enthalten Titel und Aufforderungstext.
      const pdfLang = entry.pdfLanguage ?? langCode;
      const key = `${flyer.id}:${langCode}`;

      const pdfHash = hashFile(entry.pdf);
      const mediaBase = `media/${flyer.id}/${pdfLang}`;

      // ---- Seiten rendern ----
      let pageResult;
      try {
        pageResult = await once(pagesOnce, pdfHash, () =>
          cache.use(
            {
              step: 'pages',
              pdf: pdfHash,
              renderWidth: images.renderWidth,
              widths: images.readerWidths,
              formats: images.formats,
              quality: images.quality,
              lqip: images.lqipWidth,
            },
            async (workDir) => {
              onProgress?.(`${flyer.dirName} (${pdfLang.toUpperCase()})`);
              const pages = [];
              await renderPdf(entry.pdf, { renderWidth: images.renderWidth }, async (page) => {
                const derived = await createDerivatives(page.png, {
                  dir: workDir,
                  name: pageName(page.index),
                  widths: images.readerWidths,
                  formats: images.formats,
                  quality: images.quality,
                  lqipWidth: images.lqipWidth,
                });
                // Das große PNG der ersten Seite wird für Cover und
                // Teilen-Bilder noch gebraucht.
                if (page.index === 1) fs.writeFileSync(path.join(workDir, 'page-01-full.png'), page.png);
                pages.push({ index: page.index, text: page.text, ...derived });
                renderedPages += 1;
              });
              return { pages, pageCount: pages.length };
            },
          ),
        );
      } catch (err) {
        if (err instanceof PdfError) {
          report('error', flyer, `${pdfLang.toUpperCase()}: ${err.message}`, {
            hint: err.hint,
            file: entry.pdf,
          });
          continue;
        }
        throw err;
      }

      const pagesMeta = pageResult.meta;
      const sourcePng = path.join(pageResult.dir, 'page-01-full.png');

      // Aus gescannten PDFs lässt sich kein Text auslesen. Die Seite
      // "Als Text lesen" wäre dann leer — das muss auffallen.
      if (!entry.textOverride && pagesMeta.pages.every((page) => !page.text)) {
        report('warning', flyer, `${langCode.toUpperCase()}: Aus der PDF-Datei liess sich kein Text auslesen.`, {
          file: entry.pdf,
          hint:
            'Vermutlich ein Scan oder eine Datei aus Bildern. Lege den Text als ' +
            `content/flyers/${flyer.dirName}/flyer.${langCode}.txt daneben — er ersetzt dann die automatische Fassung.`,
        });
      }

      // ---- Titelbild ----
      if (flyer.cover.page > pagesMeta.pageCount) {
        report('warning', flyer, `cover.page ist ${flyer.cover.page}, die Druckdatei hat aber nur ${pagesMeta.pageCount} Seiten.`, {
          file: flyer.sourceFile,
          hint: 'Es wird die letzte vorhandene Seite verwendet.',
        });
      }
      const coverPageIndex = Math.min(flyer.cover.page, pagesMeta.pageCount);
      const coverKey = `${pdfHash}:${coverPageIndex}:${JSON.stringify(flyer.cover.crop)}`;

      const coverResult = await once(coverOnce, coverKey, () =>
        cache.use(
          {
            step: 'cover',
            pdf: pdfHash,
            page: coverPageIndex,
            crop: flyer.cover.crop,
            widths: images.coverWidths,
            formats: images.formats,
            quality: images.quality,
            renderWidth: images.renderWidth,
          },
          async (workDir) => {
            // Ist das Titelblatt nicht die erste Seite, wird genau diese
            // Seite noch einmal in voller Größe gezeichnet. Aus der bereits
            // verkleinerten Leseansicht abzuleiten wäre sichtbar schlechter.
            const source =
              coverPageIndex === 1
                ? fs.readFileSync(sourcePng)
                : await renderPdfPage(entry.pdf, {
                    renderWidth: images.renderWidth,
                    page: coverPageIndex,
                  });
            const derived = await createDerivatives(source, {
              dir: workDir,
              name: 'cover',
              widths: images.coverWidths,
              formats: images.formats,
              quality: images.quality,
              crop: flyer.cover.crop,
              lqipWidth: images.lqipWidth,
            });
            // Große Fassung für die Bilder zum Teilen.
            const full = await createDerivatives(source, {
              dir: workDir,
              name: 'cover-full',
              widths: [1200],
              formats: ['webp'],
              quality: { webp: 92, avif: 70 },
              crop: flyer.cover.crop,
              lqipWidth: images.lqipWidth,
            });
            return { ...derived, fullFile: full.sources.webp[0].file };
          },
        ),
      );

      // ---- Bilder zum Teilen (sprachabhängig) ----
      const t = i18n.for(langCode);
      const callToAction = t('social.callToAction');
      const permanentUrl = config.urls.abs(
        config.urls.stripBase(config.urls.short('flyer', flyer.id)).slice(1),
      );

      const socialResult = await cache.use(
        {
          step: 'social',
          template: SOCIAL_TEMPLATE_VERSION,
          cover: coverResult.meta.fullFile,
          title: entry.title,
          callToAction,
          siteName: config.siteName,
          url: permanentUrl,
          shareSize: shareConfig.imageSize,
          statusSize: shareConfig.statusSize,
        },
        async (workDir) =>
          createSocialImages({
            dir: workDir,
            coverPng: fs.readFileSync(path.join(coverResult.dir, coverResult.meta.fullFile)),
            title: entry.title,
            callToAction,
            siteName: config.siteName,
            url: permanentUrl,
            shareSize: shareConfig.imageSize,
            statusSize: shareConfig.statusSize,
          }),
      );

      // ---- Dateien in die Website übernehmen ----
      const socialBase = `media/${flyer.id}/${langCode}`;

      for (const page of pagesMeta.pages) {
        for (const format of Object.keys(page.sources)) {
          for (const variant of page.sources[format]) {
            copyOnce(`${mediaBase}/${variant.file}`, path.join(pageResult.dir, variant.file));
          }
        }
      }
      for (const format of Object.keys(coverResult.meta.sources)) {
        for (const variant of coverResult.meta.sources[format]) {
          copyOnce(`${mediaBase}/${variant.file}`, path.join(coverResult.dir, variant.file));
        }
      }
      copyOnce(`${socialBase}/${socialResult.meta.share.file}`, path.join(socialResult.dir, socialResult.meta.share.file));
      copyOnce(`${socialBase}/${socialResult.meta.status.file}`, path.join(socialResult.dir, socialResult.meta.status.file));
      copyOnce(`${socialBase}/${socialResult.meta.qr.web}`, path.join(socialResult.dir, socialResult.meta.qr.web));

      // QR-Code für den Druck wird NICHT mit hochgeladen, sondern liegt
      // lokal für die Gestaltung bereit.
      const printDir = path.join(printRoot, `${flyer.id}-${flyer.slug}`);
      fs.mkdirSync(printDir, { recursive: true });
      // Beide Stile: klassisch als qr-<sprache>.svg, die übrigen mit Zusatz.
      // Ältere Zwischenspeicher kennen nur den klassischen — dann bleibt es
      // dabei, bis er beim nächsten Mal neu erzeugt wird.
      const printStile = socialResult.meta.qr.prints ?? { klassisch: socialResult.meta.qr.print };
      for (const [stil, datei] of Object.entries(printStile)) {
        const printQr = fs.readFileSync(path.join(socialResult.dir, datei), 'utf8');
        const ziel = stil === 'klassisch' ? `qr-${langCode}.svg` : `qr-${langCode}-${stil}.svg`;
        fs.writeFileSync(
          path.join(printDir, ziel),
          config.isStaging ? markAsTestOnly(printQr, permanentUrl) : printQr,
        );
      }

      // Druckausgabe zum Herunterladen, wenn im Flyer freigegeben.
      let downloadUrl = null;
      if (flyer.download && entry.hasOwnPdf) {
        const target = `${mediaBase}/${flyer.slug}-${langCode}.pdf`;
        copyOnce(target, entry.pdf);
        downloadUrl = config.urls.file(target);
      }

      byFlyer.set(key, {
        pageCount: pagesMeta.pageCount,
        pages: pagesMeta.pages.map((page) => ({
          index: page.index,
          width: page.width,
          height: page.height,
          aspect: page.aspect,
          placeholder: page.placeholder,
          sources: page.sources,
          baseUrl: config.urls.file(mediaBase),
          text: page.text,
        })),
        cover: {
          width: coverResult.meta.width,
          height: coverResult.meta.height,
          aspect: coverResult.meta.aspect,
          placeholder: coverResult.meta.placeholder,
          sources: coverResult.meta.sources,
          baseUrl: config.urls.file(mediaBase),
        },
        share: {
          url: config.urls.file(`${socialBase}/${socialResult.meta.share.file}`),
          ...shareConfig.imageSize,
        },
        status: {
          url: config.urls.file(`${socialBase}/${socialResult.meta.status.file}`),
          ...shareConfig.statusSize,
        },
        qr: config.urls.file(`${socialBase}/${socialResult.meta.qr.web}`),
        download: downloadUrl,
        permanentUrl,
        /** Von Hand hinterlegte Textfassung, falls vorhanden. */
        textOverride: entry.textOverride ?? null,
        /** Aus welcher Sprache die Druckdatei stammt, wenn sie geliehen ist. */
        borrowedFrom: entry.hasOwnPdf ? null : pdfLang,
      });
    }
  }

  const removed = cache.collectGarbage();

  return {
    manifest: byFlyer,
    issues,
    stats: {
      hits: cache.hits,
      misses: cache.misses,
      renderedPages,
      cacheRemoved: removed,
    },
    ...createMediaHelpers(byFlyer, config),
  };
}

/** Kennzeichnet einen Druck-QR-Code, der noch auf eine Testadresse zeigt. */
function markAsTestOnly(svg, url) {
  const banner = `<!-- NICHT DRUCKEN: Dieser QR-Code zeigt auf eine Testadresse (${url}).
     Sobald die endgültige Domain in config/site.json eingetragen ist, wird er beim
     nächsten Build neu erzeugt. Gedruckte QR-Codes lassen sich nicht mehr ändern. -->\n`;
  return banner + svg;
}

/** Die Funktionen, die den Vorlagen zur Verfügung stehen. */
function createMediaHelpers(byFlyer, config) {
  const get = (flyer, lang) => byFlyer.get(`${flyer.id}:${lang}`) ?? null;

  /** Baut die Angaben für ein <img>-Element. */
  const imageAttributes = (entry, sizes) => {
    if (!entry) return null;
    const webp = entry.sources.webp ?? [];
    const largest = webp[webp.length - 1];
    if (!largest) return null;
    return {
      src: `${entry.baseUrl}/${largest.file}`,
      srcset: buildSrcset(webp, entry.baseUrl),
      avif: entry.sources.avif ? buildSrcset(entry.sources.avif, entry.baseUrl) : null,
      sizes,
      width: entry.width,
      height: entry.height,
      aspect: entry.aspect,
      placeholder: entry.placeholder,
    };
  };

  return {
    /** Seitenzahl eines Flyers. */
    pageCount(flyer, lang) {
      return get(flyer, lang)?.pageCount ?? null;
    },

    /** Angaben für das Cover. */
    cover(flyer, lang, sizes = '(max-width: 30rem) 45vw, (max-width: 60rem) 30vw, 300px') {
      const media = get(flyer, lang);
      return media ? imageAttributes(media.cover, sizes) : null;
    },

    /** Fertiges Cover-Bild als HTML, mit AVIF-Alternative. */
    coverImage(ctx, flyer, lang, { eager = false, className = 'card__image', sizes } = {}) {
      const image = this.cover(flyer, lang, sizes);
      if (!image) return null;
      const t = ctx.t(lang);
      const alt = t('flyer.cover', { title: flyer.languages[lang].title });
      return pictureElement(image, { alt, className, eager });
    },

    /** Alle Seiten für die Leseansicht. */
    pages(flyer, lang) {
      return get(flyer, lang)?.pages ?? [];
    },

    /** Eine Seite als Bildangaben. */
    page(flyer, lang, index, sizes = '(max-width: 60rem) 100vw, 60rem') {
      const media = get(flyer, lang);
      const page = media?.pages.find((p) => p.index === index);
      return page ? imageAttributes(page, sizes) : null;
    },

    /** Bild für Vorschauen beim Teilen. */
    shareImage(flyer, lang) {
      const media = get(flyer, lang);
      if (!media) return null;
      const entry = flyer.languages[lang];
      return { ...media.share, alt: entry?.title ?? '' };
    },

    /** Hochformatiges Bild für Status-Beiträge. */
    statusImage(flyer, lang) {
      return get(flyer, lang)?.status ?? null;
    },

    /** QR-Code fürs Web. */
    qrUrl(flyer, lang) {
      return get(flyer, lang)?.qr ?? null;
    },

    /** Adresse der Druckausgabe, sofern freigegeben. */
    downloadUrl(flyer, lang) {
      return get(flyer, lang)?.download ?? null;
    },

    /** Der aus dem PDF gelesene Text, seitenweise. */
    text(flyer, lang) {
      return (get(flyer, lang)?.pages ?? []).map((page) => page.text);
    },

    /** Von Hand hinterlegte Textfassung — hat Vorrang vor dem ausgelesenen Text. */
    manualText(flyer, lang) {
      return get(flyer, lang)?.textOverride ?? null;
    },

    raw: get,
  };
}

/** <picture> mit AVIF und WebP. */
export function pictureElement(image, { alt, className, eager = false }) {
  return html`
    <picture>
      ${image.avif ? html`<source type="image/avif" srcset="${image.avif}" sizes="${image.sizes}" />` : null}
      <img
        class="${className}"
        src="${image.src}"
        srcset="${image.srcset}"
        sizes="${image.sizes}"
        ${attrs({
          width: image.width,
          height: image.height,
          loading: eager ? null : 'lazy',
          decoding: eager ? null : 'async',
          fetchpriority: eager ? 'high' : null,
          alt,
        })}
      />
    </picture>
  `;
}
