/**
 * Bilder zum Teilen und QR-Codes.
 *
 * Die Bilder enthalten nicht nur das Cover, sondern eine Komposition aus
 * Cover, Titel, Handlungsaufforderung, Wortmarke, Adresse und QR-Code.
 * Damit ist ein geteilter Link auch dann aussagekräftig, wenn er in einer
 * Vorschau ohne weiteren Text erscheint.
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import QRCode from 'qrcode';
import { qrSvg, QR_STILE } from './qr-style.mjs';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { registerFonts, FONT, FONT_VERSION } from './fonts.mjs';
import { shortHash } from './emit.mjs';

/** Version der Bildvorlage — gehört in den Schlüssel des Zwischenspeichers. */
// 2: QR-Codes gibt es jetzt in zwei Stilen.
export const SOCIAL_TEMPLATE_VERSION = `2|${FONT_VERSION}`;

const PALETTE = {
  paper: '#faf7f2',
  ink: '#1c1917',
  muted: '#6b635c',
  accent: '#a8553a',
  line: '#e6dfd5',
};

/** Bricht Text auf eine Breite um und begrenzt die Zeilenzahl. */
function wrapText(context, text, maxWidth, maxLines) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';

  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (context.measureText(candidate).width > maxWidth && line) {
      lines.push(line);
      line = word;
      if (lines.length === maxLines) break;
    } else {
      line = candidate;
    }
  }
  if (lines.length < maxLines && line) lines.push(line);

  // Wenn etwas weggefallen ist, die letzte Zeile mit Auslassungszeichen kürzen.
  if (lines.length === maxLines) {
    const consumed = lines.join(' ').split(/\s+/).length;
    if (consumed < words.length) {
      let last = lines[lines.length - 1];
      while (last && context.measureText(`${last}…`).width > maxWidth) {
        last = last.replace(/\s*\S+$/, '');
      }
      lines[lines.length - 1] = `${last}…`;
    }
  }
  return lines;
}

/** Zeichnet ein Bild flächenfüllend in einen Rahmen (wie object-fit: cover). */
function drawCover(context, image, x, y, width, height) {
  const scale = Math.max(width / image.width, height / image.height);
  const w = image.width * scale;
  const h = image.height * scale;
  context.drawImage(image, x + (width - w) / 2, y + (height - h) / 2, w, h);
}

/** Zeichnet ein Bild vollständig in einen Rahmen (wie object-fit: contain). */
function drawContain(context, image, x, y, width, height) {
  const scale = Math.min(width / image.width, height / image.height);
  const w = image.width * scale;
  const h = image.height * scale;
  const left = x + (width - w) / 2;
  const top = y + (height - h) / 2;

  context.save();
  context.shadowColor = 'rgba(28,25,23,0.22)';
  context.shadowBlur = 40;
  context.shadowOffsetY = 12;
  context.fillStyle = '#ffffff';
  context.fillRect(left, top, w, h);
  context.restore();

  context.drawImage(image, left, top, w, h);
  return { left, top, width: w, height: h };
}

/** QR-Code als PNG-Puffer. */
async function qrPng(url, size) {
  return QRCode.toBuffer(url, {
    type: 'png',
    width: size,
    margin: 0,
    errorCorrectionLevel: 'M',
    color: { dark: PALETTE.ink, light: '#00000000' },
  });
}

/**
 * Bild für Vorschauen in sozialen Netzwerken (1200 x 630).
 * Querformat: Cover links, Text rechts.
 */
async function renderShare(options) {
  const { coverPng, title, callToAction, siteName, displayUrl, qr, width, height } = options;
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');

  context.fillStyle = PALETTE.paper;
  context.fillRect(0, 0, width, height);

  const pad = 56;
  const coverBox = { x: pad, y: pad, width: Math.round(width * 0.3), height: height - pad * 2 };
  if (coverPng) {
    drawContain(context, await loadImage(coverPng), coverBox.x, coverBox.y, coverBox.width, coverBox.height);
  }

  const textLeft = coverBox.x + coverBox.width + 56;
  const textWidth = width - textLeft - pad;

  // Wortmarke
  context.fillStyle = PALETTE.accent;
  context.font = `22px ${FONT.sansMedium}`;
  context.textBaseline = 'alphabetic';
  context.fillText(siteName.toUpperCase(), textLeft, pad + 30);

  // Titel
  context.fillStyle = PALETTE.ink;
  let titleSize = 72;
  let lines;
  do {
    context.font = `${titleSize}px ${FONT.serifSemibold}`;
    lines = wrapText(context, title, textWidth, 3);
    if (lines.length <= 2 || titleSize <= 44) break;
    titleSize -= 6;
  } while (titleSize > 44);

  let y = pad + 130;
  for (const line of lines) {
    context.fillText(line, textLeft, y);
    y += titleSize * 1.12;
  }

  // Akzentlinie
  context.fillStyle = PALETTE.accent;
  context.fillRect(textLeft, y - titleSize * 0.55, 64, 3);

  // Handlungsaufforderung
  context.fillStyle = PALETTE.muted;
  context.font = `27px ${FONT.sansRegular}`;
  const ctaLines = wrapText(context, callToAction, textWidth - (qr ? 150 : 0), 2);
  let ctaY = height - pad - (ctaLines.length - 1) * 38 - 44;
  for (const line of ctaLines) {
    context.fillText(line, textLeft, ctaY);
    ctaY += 38;
  }

  // Adresse
  context.fillStyle = PALETTE.ink;
  context.font = `24px ${FONT.sansMedium}`;
  context.fillText(displayUrl, textLeft, height - pad);

  if (qr) {
    const qrSize = 132;
    const image = await loadImage(qr);
    context.drawImage(image, width - pad - qrSize, height - pad - qrSize, qrSize, qrSize);
  }

  return canvas.toBuffer('image/png');
}

/**
 * Hochformat für Status-Beiträge (1080 x 1920).
 * Cover groß oben, Text und QR-Code darunter.
 */
async function renderStatus(options) {
  const { coverPng, title, callToAction, siteName, displayUrl, qr, width, height } = options;
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');

  context.fillStyle = PALETTE.paper;
  context.fillRect(0, 0, width, height);

  const pad = 96;
  const coverBox = { x: pad, y: 180, width: width - pad * 2, height: 980 };
  if (coverPng) {
    drawContain(context, await loadImage(coverPng), coverBox.x, coverBox.y, coverBox.width, coverBox.height);
  }

  context.fillStyle = PALETTE.accent;
  context.font = `34px ${FONT.sansMedium}`;
  context.fillText(siteName.toUpperCase(), pad, 116);

  const textWidth = width - pad * 2;

  context.fillStyle = PALETTE.ink;
  let titleSize = 88;
  let lines;
  do {
    context.font = `${titleSize}px ${FONT.serifSemibold}`;
    lines = wrapText(context, title, textWidth, 3);
    if (lines.length <= 2 || titleSize <= 58) break;
    titleSize -= 8;
  } while (titleSize > 58);

  let y = coverBox.y + coverBox.height + 150;
  for (const line of lines) {
    context.fillText(line, pad, y);
    y += titleSize * 1.12;
  }

  context.fillStyle = PALETTE.accent;
  context.fillRect(pad, y - titleSize * 0.5, 84, 4);

  context.fillStyle = PALETTE.muted;
  context.font = `38px ${FONT.sansRegular}`;
  let ctaY = y + 70;
  for (const line of wrapText(context, callToAction, textWidth - 260, 2)) {
    context.fillText(line, pad, ctaY);
    ctaY += 52;
  }

  context.fillStyle = PALETTE.ink;
  context.font = `34px ${FONT.sansMedium}`;
  context.fillText(displayUrl, pad, height - pad);

  if (qr) {
    const qrSize = 220;
    const image = await loadImage(qr);
    context.drawImage(image, width - pad - qrSize, height - pad - qrSize + 20, qrSize, qrSize);
  }

  return canvas.toBuffer('image/png');
}

/**
 * Erzeugt beide Bilder zum Teilen sowie den QR-Code.
 *
 * @param {object} options
 * @param {string} options.dir        Zielverzeichnis
 * @param {Buffer} options.coverPng   Gerendertes Cover
 * @param {string} options.title
 * @param {string} options.callToAction
 * @param {string} options.siteName
 * @param {string} options.url        Dauerhafte Adresse des Flyers
 * @param {object} options.shareSize  { width, height }
 * @param {object} options.statusSize { width, height }
 */
export async function createSocialImages(options) {
  registerFonts();
  const { dir, url, shareSize, statusSize } = options;

  const displayUrl = url.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const qrSmall = await qrPng(url, 396);
  const qrLarge = await qrPng(url, 660);

  const shared = { ...options, displayUrl };

  const sharePng = await renderShare({ ...shared, qr: qrSmall, ...shareSize });
  const statusPng = await renderStatus({ ...shared, qr: qrLarge, ...statusSize });

  const write = async (name, png, quality) => {
    const webp = await sharp(png).webp({ quality }).toBuffer();
    const file = `${name}-${shortHash(webp)}.webp`;
    fs.writeFileSync(path.join(dir, file), webp);
    return { file, bytes: webp.length };
  };

  const share = await write('share', sharePng, 84);
  const status = await write('status', statusPng, 82);

  // QR-Code fürs Web als PNG, für den Druck als Vektor.
  const qrWebFile = `qr-${shortHash(qrSmall)}.png`;
  fs.writeFileSync(path.join(dir, qrWebFile), qrSmall);

  // Für den Druck in beiden Stilen: das Muster ist identisch, nur die Form
  // der Felder unterscheidet sich. Welcher davon auf den Flyer kommt,
  // entscheidet die Gestaltung.
  const qrPrint = {};
  for (const stil of QR_STILE) {
    const datei = stil === 'klassisch' ? 'qr-print.svg' : `qr-print-${stil}.svg`;
    fs.writeFileSync(path.join(dir, datei), await qrSvg(url, { style: stil, margin: 1, errorCorrectionLevel: 'M' }));
    qrPrint[stil] = datei;
  }

  return {
    share: { file: share.file, width: shareSize.width, height: shareSize.height, bytes: share.bytes },
    status: { file: status.file, width: statusSize.width, height: statusSize.height, bytes: status.bytes },
    qr: { web: qrWebFile, print: qrPrint.klassisch, prints: qrPrint },
    url,
  };
}
