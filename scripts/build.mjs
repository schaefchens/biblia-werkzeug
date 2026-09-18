/**
 * npm run build
 *
 * Erzeugt die vollständige statische Website in dist/.
 *
 *   --no-minify   CSS und JavaScript lesbar lassen (zum Entwickeln)
 *   --quiet       Weniger Ausgabe
 *   --force       Trotz Inhaltsfehlern bauen und fehlerhafte Flyer überspringen
 */
import crypto from 'node:crypto';
import { resolveHome } from './lib/paths.mjs';
import { loadConfig } from './lib/config.mjs';
import { loadContent } from './lib/content.mjs';
import { loadI18n } from './lib/i18n.mjs';
import { createContext } from './lib/render-context.mjs';
import { Emitter } from './lib/emit.mjs';
import { buildAssets } from './lib/assets.mjs';
import { buildFavicons } from './lib/favicon.mjs';
import { buildMedia } from './lib/media.mjs';
import { renderSitemap, renderRobots, renderHtaccess } from './lib/seo.mjs';
import { buildServerFiles } from './lib/server-files.mjs';
import { applyReleaseChecks } from './lib/release.mjs';
import { collectRedirects } from './lib/redirects.mjs';
import { checkLinks } from './lib/linkcheck.mjs';
import { buildSearchIndex, assertIndexBudget } from './lib/search-index.mjs';
import { render } from './lib/html.mjs';
import {
  blank, color, error, formatBytes, formatDuration, heading, info, ok, plural, runMain, step, warn,
} from './lib/log.mjs';

import { THEME_BOOTSTRAP } from '../src/templates/theme-bootstrap.mjs';
import { homePage } from '../src/templates/home.mjs';
import { flyerPage } from '../src/templates/flyer.mjs';
import { flyerListPage } from '../src/templates/flyer-list.mjs';
import { contentPage } from '../src/templates/content-page.mjs';
import { topicsIndexPage } from '../src/templates/topics-index.mjs';
import { notFoundPage } from '../src/templates/not-found.mjs';
import { readerPage } from '../src/templates/reader.mjs';
import { flyerTextPage } from '../src/templates/flyer-text.mjs';
import { languageBanner } from '../src/components/language-banner.mjs';
import { orderPage } from '../src/templates/order.mjs';
import { contactPage } from '../src/templates/contact.mjs';

const args = process.argv.slice(2);
const minify = !args.includes('--no-minify');
const forceMedia = args.includes('--force-media');
const quiet = args.includes('--quiet');
const force = args.includes('--force');
// --json hängt am Ende eine Zeile mit dem Ergebnis an, ohne die Ausgabe
// darüber zu verändern: der Redaktionsassistent zeigt den Fortschritt und
// liest das Ergebnis, ohne Fliesstext auswerten zu müssen.
const json = args.includes('--json');

/** Seitenteile paginieren. */
function paginate(items, perPage) {
  if (items.length === 0) return [[]];
  const pages = [];
  for (let i = 0; i < items.length; i += perPage) pages.push(items.slice(i, i + perPage));
  return pages;
}

export async function build(options = {}) {
  const started = Date.now();
  const home = options.home ?? resolveHome();
  const config = loadConfig({ home, ...options.configOverrides });
  const say = options.quiet ?? quiet ? () => {} : undefined;
  // --force heisst: die Fehler sind bekannt und gewollt übergangen.
  const allowErrors = options.force ?? force;

  if (!say) heading('Biblia — Website erzeugen');

  // --- Inhalte ---
  const i18n = loadI18n(config, { overrideDir: home.i18n });
  const content = loadContent(config, { dirs: home });
  // Unter der endgültigen Domain sind Beispielinhalte und Platzhalter
  // Fehler, keine Hinweise — und verhindern damit den Build.
  applyReleaseChecks({ config, content });

  if (content.issues.hasErrors && !allowErrors) {
    blank();
    error(plural(content.issues.errors.length, 'Fehler im Inhalt', 'Fehler im Inhalt'));
    for (const issue of content.issues.errors.slice(0, 10)) {
      info(`${color.bold(issue.subject)}: ${issue.message}`);
    }
    if (content.issues.errors.length > 10) info(color.gray('    …'));
    blank();
    info('Vollständige Liste mit:  npm run check');
    blank();
    return { ok: false, config, content, home };
  }

  const emitter = new Emitter(home.dist);

  // --- CSS, JavaScript, Schriften ---
  if (!say) step('Stilvorlagen und Skripte');
  const assets = await buildAssets({
    emitter,
    urls: config.urls,
    minify,
    themeCss: home.themeCss,
  });
  assets.icons = await buildFavicons({ emitter, urls: config.urls });

  // --- Bilder aus den PDF-Dateien ---
  if (!say) step('Bilder aus den PDF-Dateien');
  const media = await buildMedia({
    config,
    content,
    i18n,
    emitter,
    force: options.forceMedia ?? forceMedia,
    cacheDir: home.cache,
    printDir: home.printAssets,
  });
  for (const issue of media.issues) {
    const level = issue.level === 'warning' ? 'warning' : 'error';
    content.issues[level](issue.subject, issue.message, { hint: issue.hint, file: issue.file });
  }
  const mediaErrors = media.issues.filter((issue) => issue.level !== 'warning');
  // Die Seitenzahl steht erst nach dem Rendern fest.
  for (const flyer of content.flyers) {
    flyer.pageCount = media.pageCount(flyer, config.defaultLanguage);
  }

  const ctx = createContext({ config, content, i18n, assets, media });

  // --- Seiten ---
  if (!say) step('Seiten');
  const sitemap = [];
  const addToSitemap = (entry) => {
    if (!config.isStaging) sitemap.push(entry);
  };

  for (const language of config.activeLanguages) {
    const lang = language.code;
    const t = i18n.for(lang);
    const published = content.published(lang);

    // Startseite
    emitter.addPage(config.urls.stripBase(ctx.home(lang)), render(homePage(ctx, lang)));
    addToSitemap({ path: ctx.home(lang), alternates: ctx.altsForHome(), priority: '1.0' });

    // Archiv, seitenweise
    const pages = paginate(published, config.archive.perPage);
    pages.forEach((slice, index) => {
      const pageNumber = index + 1;
      const canonical = ctx.archiveUrl(lang, pageNumber);
      emitter.addPage(
        config.urls.stripBase(canonical),
        render(
          flyerListPage(ctx, {
            lang,
            title: t('archive.title'),
            flyers: slice,
            canonical,
            alternates: ctx.altsForRoute('flyer'),
            page: pageNumber,
            totalPages: pages.length,
            urlFor: (p) => ctx.archiveUrl(lang, p),
            searchable: true,
          }),
        ),
      );
      addToSitemap({
        path: canonical,
        alternates: pageNumber === 1 ? ctx.altsForRoute('flyer') : [],
        priority: pageNumber === 1 ? '0.9' : '0.4',
      });
    });

    // Flyer: Detailseite, Leseansicht und Textfassung
    for (const flyer of content.reachable(lang)) {
      const canonical = ctx.flyerUrl(flyer, lang);
      emitter.addPage(config.urls.stripBase(canonical), render(flyerPage(ctx, flyer, lang)));
      emitter.addPage(
        config.urls.stripBase(ctx.readUrl(flyer, lang)),
        render(readerPage(ctx, flyer, lang)),
      );
      emitter.addPage(
        config.urls.stripBase(ctx.textUrl(flyer, lang)),
        render(flyerTextPage(ctx, flyer, lang)),
      );
      if (flyer.status === 'published') {
        addToSitemap({
          path: canonical,
          alternates: ctx.altsForFlyer(flyer),
          lastmod: flyer.date ?? undefined,
          priority: '0.8',
        });
        // Die Leseansicht besteht nur aus Bildern. Auswertbar ist die
        // Textfassung — deshalb steht sie in der Sitemap, die Leseansicht nicht.
        addToSitemap({
          path: ctx.textUrl(flyer, lang),
          alternates: ctx.altsForFlyer(flyer, 'text'),
          priority: '0.4',
        });
      }
    }

    // Themen- und Kategorieseiten
    const taxonomies = [
      { items: content.topics, routeKey: 'topics', urlFor: (slug) => ctx.topicUrl(slug, lang) },
      { items: content.categories, routeKey: 'categories', urlFor: (slug) => ctx.categoryUrl(slug, lang) },
    ];

    for (const { items, routeKey, urlFor } of taxonomies) {
      for (const item of items.values()) {
        const entry = item.languages[lang];
        if (!entry) continue;
        // Dieselbe Bedingung wie im Archiv: ein geplanter Flyer darf auch
        // hier nicht vorzeitig auftauchen.
        const flyers = item.flyers.filter((f) => content.isListed(f, lang));
        if (flyers.length === 0) continue;

        const canonical = urlFor(item.slug);
        emitter.addPage(
          config.urls.stripBase(canonical),
          render(
            flyerListPage(ctx, {
              lang,
              title: entry.title,
              description: entry.description,
              introHtml: entry.bodyHtml,
              flyers,
              canonical,
              alternates: ctx.altsForTaxonomy(item, routeKey),
              current: routeKey === 'topics' ? 'topics' : 'flyers',
            }),
          ),
        );
        addToSitemap({
          path: canonical,
          alternates: ctx.altsForTaxonomy(item, routeKey),
          priority: '0.6',
        });
      }
    }

    // Bestellseite und Kontaktseite. Beide sind statisch — nur das
    // Absenden geht an einen PHP-Endpunkt.
    emitter.addPage(config.urls.stripBase(ctx.orderUrl(lang)), render(orderPage(ctx, lang)));
    emitter.addPage(config.urls.stripBase(ctx.contactUrl(lang)), render(contactPage(ctx, lang)));
    addToSitemap({ path: ctx.contactUrl(lang), alternates: ctx.altsForRoute('contact'), priority: '0.3' });

    // Themenübersicht
    emitter.addPage(config.urls.stripBase(ctx.topicsUrl(lang)), render(topicsIndexPage(ctx, lang)));
    addToSitemap({ path: ctx.topicsUrl(lang), alternates: ctx.altsForRoute('topics'), priority: '0.5' });

    // Redaktionelle Seiten
    for (const name of ['about', 'imprint', 'privacy']) {
      const page = content.pages.get(name);
      const entry = page?.languages[lang];
      if (!entry?.title) continue;
      const canonical = ctx.pageUrl(name, lang);
      emitter.addPage(
        config.urls.stripBase(canonical),
        render(contentPage(ctx, { lang, name, entry, canonical, alternates: ctx.altsForPage(name) })),
      );
      addToSitemap({ path: canonical, alternates: ctx.altsForPage(name), priority: '0.3' });
    }
  }

  // --- Sprachneutrale Einstiege ---
  //
  // Diese Adressen stehen auf gedruckten Flyern und werden in Messengern
  // geteilt. Sie zeigen deshalb den vollständigen Inhalt mit allen
  // Vorschau-Angaben, statt nur weiterzuleiten: Vorschaudienste führen
  // kein JavaScript aus und würden sonst eine leere Seite sehen.
  const entryLang = config.defaultLanguage;

  emitter.addPage(
    '/',
    render(
      homePage(ctx, entryLang, {
        selfPath: config.basePath,
        banner: languageBanner(ctx, { lang: entryLang, alternates: ctx.altsForHome() }),
      }),
    ),
  );
  // Bewusst NICHT in der Sitemap: diese Seite verweist über canonical auf
  // /de/. Eine Adresse, die selbst auf eine andere zeigt, gehört nicht in
  // eine Sitemap.

  for (const flyer of content.flyers) {
    // Entwürfe und geplante Flyer haben auch hier keine Adresse — sonst
    // wäre die Kurzadresse die Hintertür an der Planung vorbei.
    if (!content.isPublic(flyer)) continue;
    const lang = flyer.languages[entryLang] ? entryLang : Object.keys(flyer.languages)[0];
    if (!lang) continue;

    const shortPath = ctx.shortUrl(flyer);
    emitter.addPage(
      config.urls.stripBase(shortPath),
      render(
        flyerPage(ctx, flyer, lang, {
          selfPath: shortPath,
          banner: languageBanner(ctx, { lang, alternates: ctx.altsForFlyer(flyer) }),
        }),
      ),
    );

    const shortReadPath = ctx.shortReadUrl(flyer);
    emitter.addPage(
      config.urls.stripBase(shortReadPath),
      render(readerPage(ctx, flyer, lang, { selfPath: shortReadPath })),
    );
  }

  // 404-Seite in der Standardsprache
  emitter.add('404.html', render(notFoundPage(ctx, config.defaultLanguage)));

  // --- Suchindex ---
  const indexSizes = [];
  for (const language of config.activeLanguages) {
    const json = JSON.stringify(buildSearchIndex({ config, content, ctx, lang: language.code }));
    const gzipped = assertIndexBudget(json, config.search.maxIndexBytesGzip, language.code);
    indexSizes.push({ lang: language.code, gzipped });
    emitter.add(`search/${language.code}.json`, json);
  }

  // --- PHP-Endpunkte ---
  buildServerFiles({ emitter, config, content, assets });

  // --- Sitemap, robots, .htaccess ---
  if (!config.isStaging) {
    emitter.add('sitemap.xml', renderSitemap(config, sitemap));
  }
  emitter.add('robots.txt', renderRobots(config));

  // --- Weiterleitungen früherer Adressen ---
  //
  // Ohne diesen Schritt wäre slug_history wirkungslos und jeder geteilte
  // Link bräche bei einer Umbenennung.
  const redirects = collectRedirects({ config, content });
  const shadowed = redirects.filter((redirect) => {
    const target = config.urls.stripBase(redirect.from);
    return target !== null && emitter.files.has(`${target.replace(/^\//, '')}index.html`);
  });
  for (const redirect of shadowed) {
    content.issues.error(redirect.flyer, `Der frühere slug verdeckt eine vorhandene Seite: ${redirect.from}`, {
      hint: 'Entferne den Eintrag aus slug_history — sonst wäre diese Seite nicht mehr erreichbar.',
    });
  }
  const usableRedirects = redirects.filter((redirect) => !shadowed.includes(redirect));

  const themeHash = `sha256-${crypto.createHash('sha256').update(THEME_BOOTSTRAP).digest('base64')}`;
  emitter.add(
    '.htaccess',
    renderHtaccess(config, { cspHashes: [themeHash], redirects: usableRedirects }),
  );

  // --- Schreiben ---
  if (!say) step('Dateien schreiben');
  const result = emitter.write();

  // --- Verweise prüfen ---
  const linkReport = checkLinks(home.dist, config);

  const duration = Date.now() - started;

  if (!say) {
    blank();
    ok(`${plural(emitter.size, 'Datei', 'Dateien')} in dist/ — ${formatBytes(result.bytes)}`);
    info(
      color.gray(
        `    ${result.written} neu oder geändert, ${result.unchanged} unverändert` +
          (result.removed.length > 0 ? `, ${result.removed.length} entfernt` : ''),
      ),
    );
    info(color.gray(`    CSS ${formatBytes(assets.sizes.css)} · JavaScript ${formatBytes(assets.sizes.js)}`));
    info(
      color.gray(
        `    Medien: ${media.stats.misses} neu erzeugt, ${media.stats.hits} aus dem Zwischenspeicher` +
          (media.stats.renderedPages > 0 ? `, ${media.stats.renderedPages} PDF-Seiten gerendert` : '') +
          (media.stats.cacheRemoved > 0 ? `, ${media.stats.cacheRemoved} veraltete Einträge entfernt` : ''),
      ),
    );
    info(
      color.gray(
        `    Suchindex: ${indexSizes.map((entry) => `${entry.lang} ${(entry.gzipped / 1024).toFixed(1)} KB`).join(', ')} komprimiert`,
      ),
    );

    if (linkReport.problems.length > 0) {
      blank();
      error(plural(linkReport.problems.length, 'fehlerhafter Verweis', 'fehlerhafte Verweise'));
      for (const problem of linkReport.problems.slice(0, 15)) {
        info(`${color.bold(problem.page)} → ${problem.target}`);
        info(color.gray(`    ${problem.reason}`));
      }
      if (linkReport.problems.length > 15) info(color.gray('    …'));
    } else {
      ok(`${plural(linkReport.checked, 'Verweis geprüft', 'Verweise geprüft')} — alle in Ordnung`);
    }

    if (usableRedirects.length > 0) {
      ok(`${plural(usableRedirects.length, 'frühere Adresse wird weitergeleitet', 'frühere Adressen werden weitergeleitet')}`);
    }

    if (mediaErrors.length > 0) {
      blank();
      error(plural(mediaErrors.length, 'PDF-Datei konnte nicht verarbeitet werden', 'PDF-Dateien konnten nicht verarbeitet werden'));
      for (const issue of mediaErrors) {
        info(`${color.bold(issue.subject)}: ${issue.message}`);
        if (issue.hint) info(color.gray(`    ${issue.hint}`));
      }
    }

    if (content.issues.warnings.length > 0) {
      blank();
      warn(`${plural(content.issues.warnings.length, 'Hinweis', 'Hinweise')} — Einzelheiten mit:  npm run check`);
    }

    blank();
    ok(`Fertig in ${formatDuration(duration)}.`);
    info(color.gray('    Ansehen mit:  npm run preview'));
    blank();
  }

  // Ein leerer Lesemodus oder eine fehlende Weiterleitung darf nicht als
  // gelungener Build gelten: sonst lädt npm run publish das Ergebnis hoch.
  const failed =
    linkReport.problems.length + (allowErrors ? 0 : mediaErrors.length + shadowed.length);

  return {
    ok: failed === 0,
    config,
    content,
    home,
    assets,
    emitter,
    result,
    linkReport,
    duration,
  };
}

// Nur ausführen, wenn direkt aufgerufen — build() wird auch von preview,
// dev und publish verwendet.
if (import.meta.url === `file://${process.argv[1]}`) {
  runMain(async () => {
    const outcome = await build();
    if (json) {
      process.stdout.write(
        `${JSON.stringify({
          ok: outcome.ok,
          files: outcome.emitter?.size ?? 0,
          written: outcome.result?.written ?? 0,
          unchanged: outcome.result?.unchanged ?? 0,
          removed: outcome.result?.removed?.length ?? 0,
          bytes: outcome.result?.bytes ?? 0,
          errors: outcome.content?.issues?.errors.length ?? 0,
          warnings: outcome.content?.issues?.warnings.length ?? 0,
          linkProblems: outcome.linkReport?.problems.length ?? 0,
          duration: outcome.duration ?? 0,
        })}\n`,
      );
    }
    return outcome.ok ? 0 : 1;
  });
}
