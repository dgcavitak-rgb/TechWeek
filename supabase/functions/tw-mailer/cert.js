// Certificate of attendance (A4 landscape) — shared by the mailer and the download endpoint.
// Libraries are passed in so this file runs unchanged in Deno (edge) and Node (local preview).

const RED = [200 / 255, 35 / 255, 44 / 255];
const INK = [20 / 255, 23 / 255, 26 / 255];
const MUTED = [91 / 255, 100 / 255, 112 / 255];
const GOLD = [176 / 255, 141 / 255, 74 / 255];

// Standard PDF fonts only cover Windows-1252; strip accents and replace anything else.
function safe(s) {
  return String(s ?? "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/[^\x20-\x7E -ÿ–—•·]/g, "")
    .trim();
}

export async function buildCertificate(d, PDFLib, QRCode) {
  const { PDFDocument, StandardFonts, rgb } = PDFLib;
  const c = (a) => rgb(a[0], a[1], a[2]);
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Certificate of Attendance - ${safe(d.full_name)}`);
  pdf.setAuthor("Cavitak Marketing Pvt. Ltd.");
  const page = pdf.addPage([842, 595]);
  const W = 842, H = 595;
  const reg = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const ital = await pdf.embedFont(StandardFonts.HelveticaOblique);
  const serifB = await pdf.embedFont(StandardFonts.TimesRomanBold);

  // frame
  page.drawRectangle({ x: 0, y: 0, width: W, height: H, color: rgb(1, 1, 1) });
  page.drawRectangle({ x: 0, y: H - 14, width: W, height: 14, color: c(RED) });
  page.drawRectangle({ x: 0, y: 0, width: W, height: 6, color: c(RED) });
  page.drawRectangle({ x: 28, y: 28, width: W - 56, height: H - 70, borderColor: c(GOLD), borderWidth: 1.2 });
  page.drawRectangle({ x: 34, y: 34, width: W - 68, height: H - 82, borderColor: c(GOLD), borderWidth: 0.4 });

  const center = (text, y, font, size, color) => {
    const t = safe(text);
    let s = size;
    while (font.widthOfTextAtSize(t, s) > W - 160 && s > 9) s -= 0.5;
    const w = font.widthOfTextAtSize(t, s);
    page.drawText(t, { x: (W - w) / 2, y, size: s, font, color });
    return s;
  };
  const spaced = (text, y, font, size, color, gap) => {
    const t = safe(text).split("").join(" ".repeat(gap));
    center(t, y, font, size, color);
  };

  // brand line
  page.drawText("CAVITAK", { x: 60, y: H - 76, size: 18, font: bold, color: c(RED) });
  page.drawText("TECH WEEK  ·  PARTNER TRAINING", { x: 60, y: H - 92, size: 8.5, font: bold, color: c(MUTED) });
  const brand = safe(d.brand_line || "");
  if (brand) {
    const bw = bold.widthOfTextAtSize(brand, 9);
    page.drawText(brand, { x: W - 60 - bw, y: H - 80, size: 9, font: bold, color: c(MUTED) });
  }

  spaced("CERTIFICATE OF ATTENDANCE", H - 150, bold, 22, c(INK), 1);
  page.drawRectangle({ x: W / 2 - 40, y: H - 166, width: 80, height: 2, color: c(RED) });
  center("This is to certify that", H - 200, ital, 13, c(MUTED));
  center(d.full_name, H - 248, serifB, 36, c(INK));
  const who = [d.designation, d.organization].filter(Boolean).join(", ");
  if (who) center(who, H - 274, reg, 13, c(MUTED));
  center("has successfully attended the hands-on partner training", H - 312, reg, 13, c(INK));
  center(d.event_title, H - 340, bold, 18, c(RED));
  center(`held at ${d.venue}, ${d.city} on ${d.date_label}${d.slot_label ? " (" + d.slot_label + " session)" : ""}`, H - 366, reg, 12, c(INK));

  // signature
  const sy = 112;
  page.drawLine({ start: { x: 80, y: sy }, end: { x: 300, y: sy }, thickness: 0.8, color: c(INK) });
  page.drawText(safe(d.signer_name || "Cavitak Marketing Pvt. Ltd."), { x: 80, y: sy - 16, size: 11, font: bold, color: c(INK) });
  const st = safe(d.signer_title || "");
  if (st) page.drawText(st, { x: 80, y: sy - 30, size: 9, font: reg, color: c(MUTED) });

  // verification + QR
  const verifyUrl = d.public_url ? `${String(d.public_url).split("?")[0]}?v=${d.code}` : "";
  if (verifyUrl && QRCode) {
    const dataUrl = await QRCode.toDataURL(verifyUrl, { width: 240, margin: 0, errorCorrectionLevel: "M" });
    const bytes = Uint8Array.from(atob(dataUrl.split(",")[1]), (ch) => ch.charCodeAt(0));
    const img = await pdf.embedPng(bytes);
    page.drawImage(img, { x: W - 60 - 70, y: 60, width: 70, height: 70 });
  }
  const idText = `Certificate ID: ${d.code}`;
  page.drawText(idText, { x: W - 140 - reg.widthOfTextAtSize(idText, 9), y: 98, size: 9, font: bold, color: c(INK) });
  if (verifyUrl) {
    const vt = "Scan to verify";
    page.drawText(vt, { x: W - 140 - reg.widthOfTextAtSize(vt, 8.5), y: 84, size: 8.5, font: reg, color: c(MUTED) });
  }
  return await pdf.save();
}
