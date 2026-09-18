/**
 * Kurznamen für Adressen.
 *
 * Eigenes Modul, weil beides gebraucht wird: der Assistent für neue Flyer
 * und new.mjs auf der Kommandozeile. Aus new.mjs lässt es sich nicht
 * einbinden — die Datei startet beim Laden ihren Frage-und-Antwort-Ablauf.
 */

/** So sieht ein gültiger Kurzname aus. */
export const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** So heisst der Ordner eines Flyers: <Nummer>-<Kurzname>. */
export const FLYER_DIR = /^(\d+)-([a-z0-9]+(?:-[a-z0-9]+)*)$/;

/** Macht aus einem Titel einen Kurznamen für die Adresse. */
export function slugify(text) {
  return (
    String(text)
      // Zuerst zusammensetzen, damit die Umlaute als ein Zeichen vorliegen.
      .normalize('NFC')
      // Deutsche Umlaute vor allem anderen ersetzen. Andernfalls würde die
      // Zerlegung weiter unten aus "Über" ein "uber" machen statt des
      // üblichen "ueber".
      .replace(/ß/g, 'ss')
      .replace(/[äÄ]/g, 'ae')
      .replace(/[öÖ]/g, 'oe')
      .replace(/[üÜ]/g, 'ue')
      // Alle übrigen Akzente entfernen (é, à, ç …).
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60)
  );
}
