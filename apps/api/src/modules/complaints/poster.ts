import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import QRCode from "qrcode";

/**
 * The printable complaint QR for one location at one event.
 *
 * A coordinator prints this and tapes it up at the spot — a lab, the food
 * counter, an ad-hoc corner. Scanning it opens the report form in the app,
 * pre-attached to this event and this location, so issues reach only that
 * event's coordinators. The poster carries the club and event so a student can
 * see they are reporting to the right people.
 */

export type PosterInput = {
  qrPayload: string;
  clubName: string;
  eventTitle: string;
  eventWhen: string;
  locationLabel: string;
  locationDescription: string | null;
  reference: string;
};

const A4 = { w: 595.28, h: 841.89 };

/** pdf-lib's standard fonts are WinAnsi; replace anything they cannot encode. */
function safe(text: string): string {
  return text
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/[^\x20-\x7E]/g, "?");
}

function wrap(text: string, max: number): string[] {
  const words = safe(text).split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line.length + word.length + 1 > max && line) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

export async function renderComplaintPoster(input: PosterInput): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Report an issue — ${input.eventTitle} / ${input.locationLabel}`);
  doc.setProducer("CampusOps");
  const page = doc.addPage([A4.w, A4.h]);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const ink = rgb(0.06, 0.09, 0.16);
  const muted = rgb(0.35, 0.4, 0.5);
  const accent = rgb(0.24, 0.27, 0.85);

  const centre = (text: string, y: number, size: number, font = bold, colour = ink) => {
    const t = safe(text);
    page.drawText(t, {
      x: (A4.w - font.widthOfTextAtSize(t, size)) / 2,
      y,
      size,
      font,
      color: colour,
    });
  };

  let y = A4.h - 70;
  centre("CAMPUSOPS", y, 12, bold, accent);
  y -= 34;
  centre("Report an issue here", y, 30);
  y -= 26;
  centre("Scan this code in the CampusOps app", y, 13, regular, muted);

  // The QR is drawn as vector squares from the encoder's module matrix, so it
  // stays crisp at any print size and needs no image embedding.
  const matrix = QRCode.create(input.qrPayload, { errorCorrectionLevel: "M" }).modules;
  const count = matrix.size;
  const quiet = 4;
  const boxSize = 300;
  const cell = boxSize / (count + quiet * 2);
  const originX = (A4.w - boxSize) / 2;
  const originY = y - 40 - boxSize;

  page.drawRectangle({
    x: originX,
    y: originY,
    width: boxSize,
    height: boxSize,
    color: rgb(1, 1, 1),
    borderColor: rgb(0.85, 0.87, 0.92),
    borderWidth: 1,
  });
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (!matrix.get(row, col)) continue;
      page.drawRectangle({
        x: originX + (col + quiet) * cell,
        y: originY + boxSize - (row + quiet + 1) * cell,
        width: cell,
        height: cell,
        color: ink,
      });
    }
  }

  y = originY - 44;
  for (const line of wrap(input.locationLabel, 34).slice(0, 2)) {
    centre(line, y, 22);
    y -= 27;
  }
  if (input.locationDescription) {
    for (const line of wrap(input.locationDescription, 62).slice(0, 2)) {
      centre(line, y, 11, regular, muted);
      y -= 15;
    }
  }

  y -= 12;
  page.drawLine({
    start: { x: 70, y },
    end: { x: A4.w - 70, y },
    thickness: 1,
    color: rgb(0.88, 0.9, 0.94),
  });
  y -= 26;
  for (const line of wrap(input.eventTitle, 52).slice(0, 2)) {
    centre(line, y, 15);
    y -= 20;
  }
  centre(input.clubName, y, 12, regular, muted);
  y -= 17;
  centre(input.eventWhen, y, 11, regular, muted);
  y -= 28;
  centre("Your report goes only to the coordinators of this event.", y, 10, regular, muted);
  y -= 14;
  centre(`Location reference ${input.reference}`, y, 9, regular, muted);

  return doc.save();
}
