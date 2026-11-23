// Certificate of Attendance — "Blueprint" (Option B), theme-based. A4 landscape, vector + PNG only.
// Libraries are passed in so this file runs unchanged in Deno (edge) and Node (local preview).
//
//   buildCertificate(d, PDFLib, QRCode, fontkit)
//   d.fonts = { sans, sansMedium, sansSemi, sansBold, sansItalic, serif }  (TTF bytes, Uint8Array)
//   Pass the Latin-subset TTFs (fonts/sub/*.ttf, ~50-65 KB each, made with pyftsubset --no-hinting).
//   They are embedded whole (subset:false): fontkit's own subsetter drops glyphs from hinted Inter, and
//   embedding whole fonts also lets each run use its own OpenType features (e.g. 'case' for caps).
//   Without fontkit / d.fonts it falls back to the standard-14 fonts (not embedded) — it never throws.
//
// Type: Inter for all text (with Inter's own size-dependent tracking), a high-contrast display serif
// (Playfair Display) only for the attendee name. Text is set with real kerning (TJ adjustments from the
// font's GPOS/kern tables) and, where a label is spaced, with PDF character spacing (Tc) — never with
// space characters. Left-set lines are aligned on ink (side-bearing compensated), so every line's
// first stroke sits exactly on the 56pt edge.
//
// Layout grid (pt): page 842 x 595, 14pt engineering grid, 56pt (4 cells) outer margin.
//   Left text edge  X  = 56   — logos, title, body, signature all hang from this one edge.
//   Right edge      XR = 786  — corner art bleeds past it; QR and seal share one centre axis.
//   Bottom margin       = 56  — QR bottom and the last baseline of the signature block.
// Colours: theme1 = primary (P), theme2 = deep (D), Cavitak red = accent (ACC).

const hex = (h, f) => { h = /^#[0-9a-f]{6}$/i.test(h || "") ? h : f; return [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255); };
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const lin = (v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const lum = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const norm = (s) => String(s ?? "").normalize("NFC")
  .replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
  .replace(/[\u0000-\u001F\u007F-\u009F]/g, "").replace(/\s+/g, " ").trim();

export async function buildCertificate(d, PDFLib, QRCode, fontkit) {
  const { PDFDocument, StandardFonts, rgb, PDFOperator, PDFOperatorNames, PDFArray, PDFHexString, PDFNumber,
    pushGraphicsState, popGraphicsState, beginText, endText, setFontAndSize, setCharacterSpacing,
    setFillingRgbColor, setTextMatrix } = PDFLib;
  const C = (a) => rgb(...a.map((v) => Math.min(1, Math.max(0, v))));
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Certificate of Attendance - ${norm(d.full_name)}`);
  pdf.setAuthor("Cavitak Marketing Pvt. Ltd.");
  pdf.setSubject(norm(d.event_title));
  pdf.setCreator("Cavitak Tech Week");
  const W = 842, H = 595, page = pdf.addPage([W, H]);

  // ── fonts: embedded + subset when available, standard-14 otherwise
  const fb = d.fonts || {};
  const canEmbed = !!(fontkit && d.fonts);
  if (canEmbed) { try { pdf.registerFontkit(fontkit); } catch (_) { /* ignore */ } }
  const cache = new Map();
  const load = async (bytes, std) => {
    if (canEmbed && bytes) {
      if (cache.has(bytes)) return cache.get(bytes);
      try { const f = await pdf.embedFont(bytes, { subset: false }); cache.set(bytes, f); return f; } catch (_) { /* fall through */ }
    }
    return pdf.embedFont(std);
  };
  const F = {
    reg: await load(fb.sans, StandardFonts.Helvetica),
    semi: await load(fb.sansSemi || fb.sansBold, StandardFonts.HelveticaBold),
    bold: await load(fb.sansBold || fb.sansSemi, StandardFonts.HelveticaBold),
    ital: await load(fb.sansItalic, StandardFonts.HelveticaOblique),
    name: await load(fb.serif, StandardFonts.TimesRomanBold),
  };
  const SANS = new Set([F.reg, F.semi, F.bold, F.ital]);

  const embed = async (b) => { try { return b ? await pdf.embedPng(b) : null; } catch (_) { return null; } };
  const b64 = (u) => Uint8Array.from(atob(String(u).split(",")[1]), (ch) => ch.charCodeAt(0));
  const LOGO = await embed(d.logo_left), BR = await embed(d.logo_right);
  const sig = String(d.signature || "").startsWith("data:image/png;base64,") ? await embed(b64(d.signature)) : null;

  // ── theme
  const WHITE = [1, 1, 1], INK = hex("#12151C"), MUT = hex("#5B6470"), GRID = hex("#C9D3E6");
  const ACC = hex("#C8232C");
  const branded = /^#[0-9a-f]{6}$/i.test(d.theme1 || "");
  let P = branded ? hex(d.theme1) : hex("#2B2F36");                 // no brand → charcoal primary, red accent
  let D = hex(d.theme2, "#14171A");
  const darkTo = (c, toward) => { for (let i = 0; i < 12 && contrast(c, WHITE) < 4.5; i++) c = mix(c, i < 6 ? toward : INK, 0.2); return c; };
  if (contrast(D, WHITE) < 4.5) D = darkTo(D, INK);                   // a pale theme2 can't carry the seal / spine
  const TXT = darkTo(P, D);                                            // event title must stay legible (AA)
  if (contrast(P, WHITE) < 2) P = darkTo(P, D);                       // near-white theme1 would vanish on paper
  let SEAL = mix(P, D, 0.45); for (let i = 0; i < 8 && contrast(SEAL, WHITE) < 4.5; i++) SEAL = mix(SEAL, INK, 0.2); // white seal text
  const TINT = mix(P, WHITE, 0.72);

  // ── grid constants
  const X = 56, XR = W - 56, BOT = 56;
  const AX = XR - 35;              // shared centre axis for seal and QR (QR is 70 wide, flush to XR)
  const COLW = AX - 50 - 28 - X;   // text column stops one gutter short of the seal

  // ── typesetting ---------------------------------------------------------------------------------
  const kfont = (f) => (f.embedder && f.embedder.font && typeof f.embedder.font.layout === "function" ? f.embedder.font : null);
  const charsets = new Map();
  const charset = (f) => { if (!charsets.has(f)) { let s; try { s = new Set(f.getCharacterSet()); } catch (_) { s = null; } charsets.set(f, s); } return charsets.get(f); };
  // keep what the font can draw; otherwise try the unaccented base letter; otherwise drop the character
  const clean = (t, f) => {
    t = norm(t); const set = charset(f); if (!set) return t;
    let out = "";
    for (const ch of t) {
      if (set.has(ch.codePointAt(0))) { out += ch; continue; }
      const base = ch.normalize("NFD")[0];
      if (base && set.has(base.codePointAt(0))) out += base;
      else if (ch === "—" || ch === "–") out += "-";
    }
    return out.replace(/\s+/g, " ").trim();
  };
  // Inter's published dynamic-metrics tracking (em) — tighter at display sizes, looser at caption sizes
  const dyn = (f, s) => (SANS.has(f) && kfont(f) ? -0.0223 + 0.185 * Math.exp(-0.1745 * s) : 0);
  // measure a run: advance width with kerning + tracking, and the ink side-bearings at both ends
  function shape(t, f, s, tr, caps) {
    const k = kfont(f), track = (tr + dyn(f, s)) * s;
    if (!k) return { w: f.widthOfTextAtSize(t, s) + track * Math.max(0, t.length - 1), lsb: 0, rsb: 0, track, k };
    if (caps === undefined) caps = /[A-Z]/.test(t) && !/[a-z]/.test(t); // all-caps → Inter case-sensitive forms
    const run = k.layout(t, caps ? ["case"] : undefined), u = s / k.unitsPerEm, g = run.glyphs, p = run.positions;
    let adv = 0; for (const q of p) adv += q.xAdvance;
    const box = (gl) => { try { const b = gl.bbox; return isFinite(b.minX) && b.maxX > b.minX ? b : null; } catch (_) { return null; } };
    const b0 = g.length ? box(g[0]) : null, b1 = g.length ? box(g[g.length - 1]) : null;
    return { w: adv * u + track * Math.max(0, g.length - 1), lsb: b0 ? b0.minX * u : 0,
      rsb: b1 ? (p[p.length - 1].xAdvance - b1.maxX) * u : 0, track, k, run, u };
  }
  const fkeys = new Map();
  const fkey = (f) => { if (!fkeys.has(f)) fkeys.set(f, page.node.newFontDictionary(f.name, f.ref)); return fkeys.get(f); };
  // draw one run with TJ (glyphs + kerning adjustments) and Tc (tracking)
  function put(t, x, y, f, s, col, sh) {
    if (!t) return;
    const arr = PDFArray.withContext(pdf.context);
    if (!sh.k) arr.push(f.encodeText(t));
    else {
      const { glyphs, positions } = sh.run, upm = sh.k.unitsPerEm;     // full (pre-subset) font: CID = glyph id
      let buf = "";
      glyphs.forEach((gl, i) => {
        buf += gl.id.toString(16).padStart(4, "0");
        const kern = positions[i].xAdvance - gl.advanceWidth;           // GPOS/kern adjustment (font units)
        if (kern && i < glyphs.length - 1) { arr.push(PDFHexString.of(buf)); buf = ""; arr.push(PDFNumber.of(Math.round((-kern * 1000) / upm))); }
      });
      if (buf) arr.push(PDFHexString.of(buf));
    }
    const c = C(col);
    page.pushOperators(pushGraphicsState(), beginText(), setFillingRgbColor(c.red, c.green, c.blue),
      setFontAndSize(fkey(f), s), setCharacterSpacing(sh.track), setTextMatrix(1, 0, 0, 1, x, y),
      PDFOperator.of(PDFOperatorNames.ShowTextAdjusted, [arr]), endText(), popGraphicsState());
  }
  const wid = (t, f, s, tr = 0) => shape(clean(t, f), f, s, tr).w;
  const fit = (t, f, s, max, min = 8, tr = 0) => { while (wid(t, f, s, tr) > max && s > min) s -= 0.25; return s; };
  const clip = (t, f, s, max, tr = 0) => { t = clean(t, f); if (wid(t, f, s, tr) <= max) return t; while (t.length > 1 && wid(t + "…", f, s, tr) > max) t = t.slice(0, -1); return t.trimEnd() + "…"; };
  // left-set on ink; shrinks between s and min to fit max, then clips with an ellipsis
  const T = (t, x, y, f, s, col, o = {}) => {
    const tr = o.tr || 0; if (o.max) { s = fit(t, f, s, o.max, o.min ?? s, tr); t = clip(t, f, s, o.max, tr); } else t = clean(t, f);
    const sh = shape(t, f, s, tr); put(t, x - sh.lsb, y, f, s, col, sh); return s;
  };
  const R = (t, xr, y, f, s, col, tr = 0) => { t = clean(t, f); const sh = shape(t, f, s, tr); put(t, xr - sh.w + sh.rsb, y, f, s, col, sh); };
  const Cc = (t, cx, y, f, s, col, tr = 0) => { t = clean(t, f); const sh = shape(t, f, s, tr); put(t, cx - (sh.w - sh.lsb - sh.rsb) / 2 - sh.lsb, y, f, s, col, sh); };

  const vgrad = (x, y, w, h, c1, c2, n = 160) => { for (let i = 0; i < n; i++) page.drawRectangle({ x, y: y + (h * i) / n, width: w, height: h / n + 0.5, color: C(mix(c1, c2, i / (n - 1))) }); };
  const tri = (pts, col) => page.drawSvgPath(`M ${pts.map((q) => q.join(" ")).join(" L ")} Z`, { x: 0, y: H, color: C(col), borderWidth: 0 });
  const img = (im, x, yTop, h, maxW = 999) => { if (!im) return 0; let w = (im.width * h) / im.height; if (w > maxW) { h = (h * maxW) / w; w = maxW; } page.drawImage(im, { x, y: yTop - h, width: w, height: h }); return w; };

  // ── paper + engineering grid (14pt minor / 70pt major), washed back so it never competes with type
  page.drawRectangle({ x: 0, y: 0, width: W, height: H, color: C(WHITE) });
  for (let gx = 0; gx <= W; gx += 14) page.drawLine({ start: { x: gx, y: 0 }, end: { x: gx, y: H }, thickness: gx % 70 ? 0.25 : 0.5, color: C(GRID), opacity: gx % 70 ? 0.16 : 0.28 });
  for (let gy = 0; gy <= H; gy += 14) page.drawLine({ start: { x: 0, y: gy }, end: { x: W, y: gy }, thickness: gy % 70 ? 0.25 : 0.5, color: C(GRID), opacity: gy % 70 ? 0.16 : 0.28 });

  // ── left spine: deep brand tone (bottom) rising into Cavitak red (top)
  // A straight RGB blend between hues far apart (teal/green → red) turns grey-brown in the middle, so in
  // that case the spine runs deep → primary and the red sits as a 3pt inner rule instead.
  const chroma = (c) => Math.max(...c) - Math.min(...c), SP = mix(P, D, 0.35);
  if (chroma(mix(SP, ACC, 0.5)) >= 0.6 * (chroma(SP) + chroma(ACC)) / 2) vgrad(0, 0, 18, H, SP, ACC);
  else { vgrad(0, 0, 15, H, D, P); page.drawRectangle({ x: 15, y: 0, width: 3, height: H, color: C(ACC) }); }

  // ── corner art: three opaque facets, every edge anchored to the page edge (SVG coords, y down)
  tri([[W - 336, 0], [W - 262, 0], [W, 172]], TINT);                 // tint wedge along the primary's edge
  tri([[W - 262, 0], [W, 0], [W, 172]], P);                         // primary facet
  tri([[W - 148, 0], [W, 0], [W, 252]], mix(ACC, WHITE, 0.12));     // accent facet, steeper, crossing it
  const ux = (172 - 252) / (252 / 148 - 172 / 262), uy = 172 + (172 / 262) * ux; // exact crossing point
  tri([[W - 148, 0], [W, 0], [W, 172], [W + ux, uy]], ACC);          // overlap reads one step deeper

  // ── header: Cavitak, then partner brand stacked beneath
  const yLogoTop = H - BOT;                                          // 539
  img(LOGO, X, yLogoTop, 30, 200);
  if (BR) { T("IN ASSOCIATION WITH", X, yLogoTop - 52, F.semi, 6.5, MUT, { tr: 0.12 }); img(BR, X, yLogoTop - 62, 19, 140); }

  // ── title: caps with moderate display tracking; sub-line as a small spaced label
  T("CERTIFICATE", X, 404, F.semi, 32, INK, { tr: 0.1 });
  T("OF ATTENDANCE", X, 381, F.semi, 10.5, ACC, { tr: 0.14 });

  // ── body
  T("This is to certify that", X, 342, F.ital, 12, MUT);
  T(d.full_name, X, 293, F.name, 42, INK, { max: COLW, min: 24 });
  const who = [d.designation, d.organization].map(norm).filter(Boolean).join(", ");
  if (who) T(who, X, 268, F.reg, 12.5, MUT, { max: COLW, min: 9 });
  page.drawRectangle({ x: X, y: 249, width: 48, height: 2.5, color: C(ACC) });
  T("has successfully attended the hands-on partner training", X, 224, F.reg, 12, INK);
  // event title: one line down to 14pt; beyond that, two lines at 15pt rather than shrinking further
  let yMeta = 180;
  const ev = clean(d.event_title, F.semi);
  if (wid(ev, F.semi, 14) <= COLW) T(ev, X, 202, F.semi, 17, TXT, { max: COLW, min: 14 });
  else {
    const words = ev.split(" "); let a = "";
    while (words.length && wid(a ? a + " " + words[0] : words[0], F.semi, 15) <= COLW) a = a ? a + " " + words.shift() : words.shift();
    if (!a) a = words.shift();                                     // single unbreakable word
    T(a, X, 202, F.semi, 15, TXT, { max: COLW, min: 9 }); T(words.join(" "), X, 183, F.semi, 15, TXT, { max: COLW, min: 11 });
    yMeta = 161;
  }

  // meta: venue · date · session — one line if it fits, otherwise venue on its own line
  const city = norm(d.city), venue = norm(d.venue);
  const where = venue && city && !venue.toLowerCase().includes(city.toLowerCase()) ? `${venue}, ${city}` : venue || city;
  const when = [norm(d.date_label), d.slot_label ? `${norm(d.slot_label)} session` : ""].filter(Boolean).join("  ·  ");
  const meta = [where, when].filter(Boolean).join("  ·  ");
  if (wid(meta, F.reg, 10.5) <= COLW) T(meta, X, yMeta, F.reg, 10.5, MUT);
  else { T(where, X, yMeta, F.reg, 10.5, MUT, { max: COLW, min: 8.5 }); T(when, X, yMeta - 14, F.reg, 10.5, MUT, { max: COLW, min: 8.5 }); }

  // ── seal: on the QR axis, optically centred on the name → event block
  const sx = AX, sy = 250, r = 50;
  page.drawCircle({ x: sx, y: sy, size: r + 4, borderColor: C(SEAL), borderWidth: 0.6, opacity: 0 });
  page.drawCircle({ x: sx, y: sy, size: r, color: C(SEAL) });
  page.drawCircle({ x: sx, y: sy, size: r - 4, borderColor: C(WHITE), borderWidth: 0.6, borderOpacity: 0.7, opacity: 0 });
  for (let i = 0; i < 60; i++) {
    const a = (i / 60) * Math.PI * 2 + Math.PI / 2, r1 = r - 8.5, r2 = r - (i % 5 ? 11.5 : 14.5);
    page.drawLine({ start: { x: sx + r1 * Math.cos(a), y: sy + r1 * Math.sin(a) }, end: { x: sx + r2 * Math.cos(a), y: sy + r2 * Math.sin(a) }, thickness: i % 5 ? 0.45 : 0.8, color: C(WHITE), opacity: i % 5 ? 0.55 : 0.85 });
  }
  const yr = (String(d.date_label || "").match(/\b(20\d\d)\b/) || [])[1] || "";
  Cc("TECH WEEK", sx, sy + 11, F.semi, 6, WHITE, 0.14);
  page.drawRectangle({ x: sx - 9, y: sy + 5.5, width: 18, height: 1.2, color: C(ACC) });
  if (yr) { Cc(yr, sx, sy - 10.5, F.bold, 16, WHITE); Cc("CERTIFIED", sx, sy - 21, F.semi, 5.2, WHITE, 0.14); }
  else Cc("CERTIFIED", sx, sy - 9, F.semi, 8, WHITE, 0.12);

  // ── signature block (bottom-left) — last baseline sits on the bottom margin
  const yRule = BOT + 30;                                            // 86
  if (sig) { const k = Math.min(170 / sig.width, 46 / sig.height); page.drawImage(sig, { x: X + 4, y: yRule + 3, width: sig.width * k, height: sig.height * k }); }
  page.drawLine({ start: { x: X, y: yRule }, end: { x: X + 224, y: yRule }, thickness: 0.6, color: C(INK) });
  T(norm(d.signer_name) || "Cavitak Marketing Pvt. Ltd.", X, BOT + 14, F.semi, 10.5, INK, { max: 300, min: 8 });
  if (d.signer_title) T(d.signer_title, X, BOT, F.reg, 8.5, MUT, { max: 300, min: 7 });

  // ── verification (bottom-right): QR flush to the right margin, text baselines mirror the signature block
  const verifyUrl = d.public_url ? `${String(d.public_url).split("?")[0]}?v=${encodeURIComponent(d.code || "")}` : "";
  const Q = 70, qx = XR - Q, qy = BOT;
  if (verifyUrl && QRCode) {
    try {
      const u = await QRCode.toDataURL(verifyUrl, { width: 320, margin: 0, errorCorrectionLevel: "M", color: { dark: "#12151C", light: "#FFFFFF" } });
      page.drawRectangle({ x: qx - 5, y: qy - 5, width: Q + 10, height: Q + 10, color: C(WHITE) });
      page.drawImage(await pdf.embedPng(b64(u)), { x: qx, y: qy, width: Q, height: Q });
    } catch (_) { /* certificate still valid without the QR */ }
  }
  const tx = qx - 14;
  R("CERTIFICATE ID", tx, yRule, F.semi, 6.5, MUT, 0.12);
  R(norm(d.code), tx, BOT + 14, F.semi, 10.5, INK, 0.02);
  R("Scan to verify", tx, BOT, F.reg, 8.5, MUT);
  return await pdf.save();
}
