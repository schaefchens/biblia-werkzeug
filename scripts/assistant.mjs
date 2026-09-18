/**
 * npm run assistant
 *
 * Der Redaktionsassistent gehört nicht zum Werkzeug. Er ist ein eigenes
 * Repository und liegt als Submodul unter assistant/: eine Bedienoberfläche
 * für Mitarbeiter ohne Terminal. Die Website lässt sich ohne ihn vollständig
 * erzeugen, prüfen und veröffentlichen.
 *
 * Diese Datei ist nur der Einstieg. Sie existiert, damit "npm run assistant"
 * dort funktioniert, wo Mitarbeiter es gelernt haben, und damit ein nicht
 * geladenes Submodul einen Satz ergibt statt ERR_MODULE_NOT_FOUND.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { SYS } from './lib/paths.mjs';
import { blank, color, info, warn } from './lib/log.mjs';

const einstieg = path.join(SYS.root, 'assistant', 'scripts', 'assistant.mjs');

if (!fs.existsSync(einstieg)) {
  // Kein runMain() und kein fail(): der echte Einstieg bringt sein eigenes
  // mit, und zwei davon ineinander würden jede Meldung doppelt rahmen.
  blank();
  warn('Der Redaktionsassistent ist nicht eingerichtet.');
  blank();
  info('Er ist ein eigenes Repository und wird als Submodul geladen. Einmalig:');
  info(color.gray('    git -C werkzeug submodule update --init assistant'));
  blank();
  info(color.gray('Alle übrigen Befehle brauchen ihn nicht.'));
  process.exit(1);
}

await import(pathToFileURL(einstieg));
