/**
 * Die beiden QR-Stile.
 *
 * Ein QR-Code auf einem gedruckten Flyer muss jahrelang funktionieren. Der
 * runde Stil darf deshalb nur anders *aussehen* — das Muster, die
 * Fehlerkorrektur und der Ruhebereich müssen identisch bleiben. Genau das
 * wird hier geprüft, und zwar so, wie ein Lesegerät es sieht: durch Abtasten
 * der Feldmitten im gerenderten Bild.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import QRCode from 'qrcode';
import sharp from 'sharp';

import { qrSvg, QR_STILE, QR_BEZEICHNUNG } from './qr-style.mjs';

const URL_KURZ = 'https://biblia.at/f/101/';
const RAND = 1;

/** Tastet die Mitte jedes Feldes ab — genau das tut ein Lesegerät auch. */
async function felderLesen(svg, size, skala = 12) {
  const gesamt = size + RAND * 2;
  const { data, info } = await sharp(Buffer.from(svg))
    .resize(gesamt * skala, gesamt * skala, { kernel: 'nearest' })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const felder = [];
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const px = Math.floor((x + RAND + 0.5) * skala);
      const py = Math.floor((y + RAND + 0.5) * skala);
      felder.push(data[(py * info.width + px) * info.channels] < 128 ? 1 : 0);
    }
  }
  return felder;
}

test('Beide Stile enthalten genau dasselbe Muster', async () => {
  const { modules } = QRCode.create(URL_KURZ, { errorCorrectionLevel: 'M' });
  const erwartet = [...modules.data].map((wert) => (wert === 1 ? 1 : 0));

  for (const stil of QR_STILE) {
    const gelesen = await felderLesen(await qrSvg(URL_KURZ, { style: stil, margin: RAND }), modules.size);
    assert.deepEqual(gelesen, erwartet, `Stil "${stil}" weicht vom Muster ab`);
  }
});

test('Auch bei längeren Adressen bleibt das Muster gleich', async () => {
  const lang = 'https://biblia.schaefchens.de/v3/de/flyer/eine-ziemlich-lange-adresse/';
  const { modules } = QRCode.create(lang, { errorCorrectionLevel: 'M' });
  const erwartet = [...modules.data].map((wert) => (wert === 1 ? 1 : 0));
  const gelesen = await felderLesen(await qrSvg(lang, { style: 'rund', margin: RAND }), modules.size);
  assert.deepEqual(gelesen, erwartet);
});

test('Der Ruhebereich ist bei beiden gleich gross', async () => {
  for (const stil of QR_STILE) {
    const svg = await qrSvg(URL_KURZ, { style: stil, margin: RAND });
    const groesse = /viewBox="0 0 (\d+) (\d+)"/.exec(svg);
    assert.ok(groesse, `Stil "${stil}" hat keine viewBox`);
    assert.equal(groesse[1], groesse[2], 'quadratisch');
    assert.equal(Number(groesse[1]), 25 + RAND * 2);
  }
});

test('Der Hintergrund ist weiss und die Felder sind schwarz', async () => {
  for (const stil of QR_STILE) {
    const svg = await qrSvg(URL_KURZ, { style: stil });
    assert.match(svg, /#ffffff/, `Stil "${stil}": kein weisser Grund`);
    assert.match(svg, /#000000/, `Stil "${stil}": keine schwarzen Felder`);
    // Kein Grau, keine Transparenz — beides kostet Kontrast.
    assert.ok(!/opacity|rgba|#[0-9a-f]{3}\b/i.test(svg), `Stil "${stil}": unerwartete Farbangabe`);
  }
});

test('Der klassische Stil bleibt Byte für Byte der bisherige', async () => {
  const vorher = await QRCode.toString(URL_KURZ, {
    type: 'svg', margin: 1, errorCorrectionLevel: 'M',
    color: { dark: '#000000', light: '#ffffff' },
  });
  assert.equal(await qrSvg(URL_KURZ, { style: 'klassisch', margin: 1 }), vorher);
});

test('Ein einzelnes Feld wird zum Kreis, benachbarte verschmelzen', async () => {
  const svg = await qrSvg(URL_KURZ, { style: 'rund' });
  // Runde Ecken heisst: es gibt Bögen. Und der klassische hat keine.
  assert.match(svg, /A0\.5 0\.5/);
  assert.ok(!/A/.test(await qrSvg(URL_KURZ, { style: 'klassisch' })));
});

test('Ein erfundener Stil wird abgelehnt', async () => {
  await assert.rejects(() => qrSvg(URL_KURZ, { style: 'neon' }), /Unbekannter QR-Stil/);
});

test('Jeder Stil hat eine Bezeichnung für die Oberfläche', () => {
  for (const stil of QR_STILE) {
    assert.ok(QR_BEZEICHNUNG[stil], `"${stil}" hat keine Bezeichnung`);
  }
});
