/**
 * QR-Codes in zwei Stilen.
 *
 * Der klassische ist der sichere: scharfe Quadrate, wie es die Norm
 * vorsieht, und das, was Lesegeräte seit jeher erwarten. Der runde sieht
 * moderner aus — die Ecken der Felder sind abgerundet, aneinandergrenzende
 * Felder verschmelzen zu weichen Bändern.
 *
 * Wichtig dabei: es wird nur die *Form* geändert, nicht das Muster. Beide
 * Stile enthalten genau dieselben dunklen Felder, dieselbe
 * Fehlerkorrekturstufe und denselben Ruhebereich. Ein QR-Code auf einem
 * gedruckten Flyer muss jahrelang funktionieren; ein Stil, der Felder
 * verkleinert oder den Kontrast senkt, wäre den Blick nicht wert.
 *
 * Trotzdem bleibt ein Rest: abgerundete Kanten sind für ein Lesegerät etwas
 * schwerer zu finden als scharfe. Für sehr kleinen Druck, raues Papier oder
 * schlechte Lichtverhältnisse ist der klassische Stil die bessere Wahl.
 */
import QRCode from 'qrcode';

/** Die Stile, die es gibt. Der erste ist die Vorgabe. */
export const QR_STILE = Object.freeze(['klassisch', 'rund']);

export const QR_BEZEICHNUNG = Object.freeze({
  klassisch: 'Klassisch',
  rund: 'Abgerundet',
});

const zahl = (wert) => Number(wert.toFixed(3)).toString();

/**
 * Ein abgerundetes Rechteck, bei dem jede Ecke einzeln gerundet wird.
 * Gerundet wird nur dort, wo kein Nachbar anschliesst — so verschmelzen
 * benachbarte Felder zu einem durchgehenden Band.
 */
function feld(x, y, ecken, r) {
  const [tl, tr, br, bl] = ecken.map((gerundet) => (gerundet ? r : 0));
  const teile = [`M${zahl(x + tl)} ${zahl(y)}`];

  teile.push(`H${zahl(x + 1 - tr)}`);
  if (tr) teile.push(`A${zahl(tr)} ${zahl(tr)} 0 0 1 ${zahl(x + 1)} ${zahl(y + tr)}`);
  teile.push(`V${zahl(y + 1 - br)}`);
  if (br) teile.push(`A${zahl(br)} ${zahl(br)} 0 0 1 ${zahl(x + 1 - br)} ${zahl(y + 1)}`);
  teile.push(`H${zahl(x + bl)}`);
  if (bl) teile.push(`A${zahl(bl)} ${zahl(bl)} 0 0 1 ${zahl(x)} ${zahl(y + 1 - bl)}`);
  teile.push(`V${zahl(y + tl)}`);
  if (tl) teile.push(`A${zahl(tl)} ${zahl(tl)} 0 0 1 ${zahl(x + tl)} ${zahl(y)}`);

  return `${teile.join('')}Z`;
}

/**
 * Erzeugt einen QR-Code als SVG.
 *
 * @param {string} url
 * @param {object} [options]
 * @param {string} [options.style]   'klassisch' oder 'rund'
 * @param {number} [options.margin]  Ruhebereich in Feldern
 * @param {string} [options.errorCorrectionLevel]
 * @returns {Promise<string>}
 */
export async function qrSvg(url, { style = 'klassisch', margin = 1, errorCorrectionLevel = 'M' } = {}) {
  if (!QR_STILE.includes(style)) {
    throw new Error(`Unbekannter QR-Stil: ${style}. Erlaubt: ${QR_STILE.join(', ')}.`);
  }

  // Der klassische Stil kommt unverändert aus dem Paket — er soll sich Byte
  // für Byte weiter so verhalten wie bisher.
  if (style === 'klassisch') {
    return QRCode.toString(url, {
      type: 'svg',
      margin,
      errorCorrectionLevel,
      color: { dark: '#000000', light: '#ffffff' },
    });
  }

  const { modules } = QRCode.create(url, { errorCorrectionLevel });
  const { data, size } = modules;
  const gesamt = size + margin * 2;
  const dunkel = (x, y) => x >= 0 && y >= 0 && x < size && y < size && data[y * size + x] === 1;

  // 0.5 rundet ein einzelnes Feld zum Kreis; benachbarte Felder bleiben
  // verbunden, weil dort nicht gerundet wird.
  const radius = 0.5;
  const pfade = [];
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (!dunkel(x, y)) continue;
      const oben = dunkel(x, y - 1);
      const unten = dunkel(x, y + 1);
      const links = dunkel(x - 1, y);
      const rechts = dunkel(x + 1, y);
      pfade.push(feld(x + margin, y + margin, [
        !oben && !links,
        !oben && !rechts,
        !unten && !rechts,
        !unten && !links,
      ], radius));
    }
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${gesamt} ${gesamt}">` +
    `<rect width="${gesamt}" height="${gesamt}" fill="#ffffff"/>` +
    `<path fill="#000000" d="${pfade.join('')}"/>` +
    '</svg>\n'
  );
}
