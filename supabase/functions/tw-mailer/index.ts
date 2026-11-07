// Cavitak Tech Week — email worker
// Triggered by the database (pg_net) for every row inserted into tw_outbox.
// Sends via Gmail/Workspace SMTP (SMTP_USER + SMTP_PASS) when set, otherwise Resend (RESEND_API_KEY).
import { createClient } from "npm:@supabase/supabase-js@2";
import QRCode from "npm:qrcode@1.5.4";
import nodemailer from "npm:nodemailer@6.9.16";
import * as PDFLib from "npm:pdf-lib@1.17.1";
import { buildCertificate } from "./cert.js";

const SB = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});
const RED = "#C8232C";
const INK = "#1F2328";
const MUTED = "#5B6470";

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

// Secret names typed in the dashboard sometimes carry stray spaces; match them by trimmed name.
function envGet(name: string): string {
  const direct = Deno.env.get(name);
  if (direct) return direct.trim();
  const all = Deno.env.toObject();
  for (const k of Object.keys(all)) if (k.trim().toUpperCase() === name) return (all[k] || "").trim();
  return "";
}

const FN_URL = (Deno.env.get("SUPABASE_URL") || "") + "/functions/v1/tw-mailer";

async function certBytes(pass: string) {
  const { data: d, error } = await SB.rpc("tw_cert_payload", { p_pass: pass });
  if (error || !d?.ok) return null;
  return await buildCertificate(d, PDFLib, QRCode);
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (req.method === "GET" && url.searchParams.get("cert")) {
    const bytes = await certBytes(url.searchParams.get("cert")!);
    if (!bytes) return new Response("Certificate not available — it is issued after you attend the session.", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    return new Response(bytes, { headers: { "Content-Type": "application/pdf", "Content-Disposition": 'inline; filename="Cavitak-Tech-Week-Certificate.pdf"', "Access-Control-Allow-Origin": "*" } });
  }
  if (req.method !== "POST") return json({ ok: true, service: "tw-mailer",
    provider: (envGet("SMTP_USER") && envGet("SMTP_PASS")) ? "gmail-smtp" : envGet("RESEND_API_KEY") ? "resend" : "none" });
  const secret = req.headers.get("x-tw-hook") ?? "";
  let id: number;
  try { id = Number((await req.json()).id); } catch { return json({ ok: false, error: "bad body" }, 400); }
  if (!secret || !id) return json({ ok: false, error: "forbidden" }, 403);

  const { data: p, error } = await SB.rpc("tw__email_payload", { p_id: id, p_secret: secret });
  if (error) return json({ ok: false, error: error.message }, 500);
  if (!p?.ok) return json(p ?? { ok: false }, p?.error === "forbidden" ? 403 : 200);

  try {
    const mail = await build(p);
    const providerId = await send(p, mail);
    await SB.rpc("tw__email_result", { p_id: id, p_secret: secret, p_ok: true, p_err: null, p_provider_id: providerId });
    return json({ ok: true });
  } catch (e) {
    const msg = String((e as Error)?.message ?? e).slice(0, 500);
    await SB.rpc("tw__email_result", { p_id: id, p_secret: secret, p_ok: false, p_err: msg, p_provider_id: null });
    return json({ ok: false, error: msg }, 500);
  }
});

function b64(bytes: Uint8Array) {
  let bin = ""; const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(bin);
}

type Mail = { subject: string; html: string; text: string; attachments: { filename: string; content: string; type: string }[] };

function passUrl(p: any) {
  const base = (p.settings?.public_url ?? "").trim();
  if (!base) return "";
  return base + (base.includes("?") ? "&" : "?") + "p=" + p.reg.pass_token;
}
function consoleUrl(p: any) {
  const base = (p.settings?.public_url ?? "").trim();
  return base ? base.split("?")[0] + "#console" : "";
}

async function qrAssets(p: any) {
  const content = passUrl(p) || "TW:" + p.reg.pass_token;
  const dataUrl: string = await QRCode.toDataURL(content, { width: 420, margin: 2, errorCorrectionLevel: "M" });
  const b64 = dataUrl.split(",")[1];
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const path = `qr/${p.reg.pass_token}.png`;
  let publicUrl = "";
  const up = await SB.storage.from("tw-qr").upload(path, bytes, { contentType: "image/png", upsert: true });
  if (!up.error) publicUrl = SB.storage.from("tw-qr").getPublicUrl(path).data.publicUrl;
  return { b64, publicUrl };
}

function icsDate(iso: string) {
  return new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}
function icsEsc(s: string) {
  return String(s ?? "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}
function buildIcs(p: any, cancel = false) {
  const v = p.venue, s = p.slot, e = p.event;
  const loc = [v.name, v.room_name, v.address].filter(Boolean).join(", ");
  const desc = [e.description, e.agenda ? "Agenda:\n" + e.agenda : "", v.map_url ? "Map: " + v.map_url : "",
    passUrl(p) ? "Your pass: " + passUrl(p) : ""].filter(Boolean).join("\n\n");
  return [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Cavitak//Tech Week//EN", "CALSCALE:GREGORIAN",
    cancel ? "METHOD:CANCEL" : "METHOD:PUBLISH",
    "BEGIN:VEVENT", `UID:${p.reg.id}@techweek.cavitak`, `DTSTAMP:${icsDate(new Date().toISOString())}`,
    `DTSTART:${icsDate(s.starts_at)}`, `DTEND:${icsDate(s.ends_at)}`,
    `SUMMARY:${icsEsc(e.title + " — " + s.label)}`, `LOCATION:${icsEsc(loc)}`, `DESCRIPTION:${icsEsc(desc)}`,
    cancel ? "STATUS:CANCELLED" : "STATUS:CONFIRMED",
    "BEGIN:VALARM", "TRIGGER:-PT2H", "ACTION:DISPLAY", "DESCRIPTION:Tech Week session", "END:VALARM",
    "END:VEVENT", "END:VCALENDAR",
  ].join("\r\n");
}

function detailsBlock(p: any, opts: { showAgenda?: boolean } = {}) {
  const v = p.venue, s = p.slot, e = p.event;
  const row = (k: string, val: string) =>
    `<tr><td style="padding:6px 12px 6px 0;color:${MUTED};font-size:13px;vertical-align:top;white-space:nowrap">${k}</td>` +
    `<td style="padding:6px 0;color:${INK};font-size:14px;line-height:1.45">${val}</td></tr>`;
  const venueLine = esc(v.name) + (v.room_name ? ` · ${esc(v.room_name)}` : "") + `, ${esc(v.city)}`;
  const mapBtn = v.map_url
    ? `<div style="margin-top:6px"><a href="${esc(v.map_url)}" style="color:${RED};font-weight:600;text-decoration:none">Open in Google Maps →</a></div>`
    : "";
  return `
  <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border:1px solid #E6E8EB;border-radius:10px;padding:14px 16px;background:#FAFBFC">
    <tr><td>
      <table role="presentation" cellpadding="0" cellspacing="0">
        ${row("Event", `<strong>${esc(e.title)}</strong>`)}
        ${row("Date", `<strong>${esc(s.date_label)}</strong>`)}
        ${row("Slot", `<strong>${esc(s.label)}</strong> · ${esc(s.time_label)}`)}
        ${row("Venue", venueLine)}
        ${row("Address", esc(v.address).replace(/\n/g, "<br>") + mapBtn)}
        ${v.contact_name || v.contact_phone || v.contact_email ? row("Contact", esc([v.contact_name, v.contact_phone].filter(Boolean).join(" · ")) + (v.contact_email ? `${v.contact_name || v.contact_phone ? " · " : ""}<a href="mailto:${esc(v.contact_email)}" style="color:${RED};text-decoration:none">${esc(v.contact_email)}</a>` : "")) : ""}
        ${v.instructions ? row("Please note", esc(v.instructions).replace(/\n/g, "<br>")) : ""}
        ${opts.showAgenda && e.agenda ? row("Agenda", esc(e.agenda).replace(/\n/g, "<br>")) : ""}
      </table>
    </td></tr>
  </table>`;
}

function shell(p: any, headline: string, bodyHtml: string, preheader: string) {
  const brand = esc(p.settings?.brand_name || "Cavitak");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:#F2F3F5;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif">
<span style="display:none;max-height:0;overflow:hidden">${esc(preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F2F3F5;padding:24px 12px">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#fff;border-radius:12px;overflow:hidden">
  <tr><td style="background:${RED};padding:18px 24px;color:#fff">
    <div style="font-size:12px;letter-spacing:.12em;text-transform:uppercase;opacity:.9">${brand} · Tech Week</div>
    <div style="font-size:21px;font-weight:700;margin-top:4px">${esc(headline)}</div>
  </td></tr>
  <tr><td style="padding:22px 24px;color:${INK};font-size:15px;line-height:1.55">${bodyHtml}</td></tr>
  <tr><td style="padding:14px 24px;border-top:1px solid #EEF0F2;color:${MUTED};font-size:12px;line-height:1.5">
    ${p.outbox?.kind === "invite" ? "You are receiving this invitation as a Cavitak partner. Reply 'unsubscribe' and we won't email you about this event again." : `You are receiving this because you registered for ${esc(p.event.title)}. Your details are used only to manage this training.`}
    ${p.settings?.reply_to ? `Questions? Reply to this email or write to ${esc(p.settings.reply_to)}.` : ""}
  </td></tr>
</table></td></tr></table></body></html>`;
}

const btn = (href: string, label: string) =>
  href ? `<a href="${esc(href)}" style="display:inline-block;background:${RED};color:#fff;text-decoration:none;font-weight:600;padding:11px 18px;border-radius:8px;margin:4px 8px 4px 0">${esc(label)}</a>` : "";
const linkBtn = (href: string, label: string) =>
  href ? `<a href="${esc(href)}" style="display:inline-block;color:${RED};text-decoration:none;font-weight:600;padding:11px 4px;margin:4px 8px 4px 0">${esc(label)}</a>` : "";

async function build(p: any): Promise<Mail> {
  const kind = p.outbox.kind as string;
  const r = p.reg, s = p.slot, e = p.event, v = p.venue;
  const first = esc(String(r.full_name).split(" ")[0]);
  const when = s ? `${s.date_label} · ${s.label}` : "";
  const pass = r.pass_token ? passUrl(p) : "";
  const attachments: Mail["attachments"] = [];
  let subject = "", headline = "", body = "", pre = "";

  const qrBlock = async (lead: string) => {
    const q = await qrAssets(p);
    attachments.push({ filename: "tech-week-pass.png", content: q.b64, type: "image/png" });
    const img = q.publicUrl
      ? `<img src="${esc(q.publicUrl)}" width="200" height="200" alt="Your entry QR code" style="display:block;margin:0 auto;border:0">`
      : `<div style="color:${MUTED};font-size:13px">Your QR code is attached to this email.</div>`;
    return `<div style="text-align:center;border:1px dashed #D0D4D9;border-radius:12px;padding:16px;margin:18px 0">
      <div style="font-size:13px;color:${MUTED};margin-bottom:10px">${esc(lead)}</div>${img}
      <div style="font-size:15px;font-weight:700;margin-top:10px">${esc(r.full_name)}</div>
      <div style="font-size:13px;color:${MUTED}">${esc([r.designation, r.organization].filter(Boolean).join(" · "))}</div></div>`;
  };
  const addIcs = (cancel = false) =>
    attachments.push({ filename: cancel ? "cancelled.ics" : "tech-week.ics", content: btoa(unescape(encodeURIComponent(buildIcs(p, cancel)))), type: "text/calendar" });

  switch (kind) {
    case "received":
      subject = `Request received — ${e.title} · ${when}`;
      headline = "We've received your request";
      pre = `Your request for ${when} is under review.`;
      body = `<p>Hi ${first},</p><p>Thank you for registering. Seats are limited, so each request is reviewed by our team.
        You'll receive a confirmation email with your <strong>entry QR pass</strong> once approved.</p>
        ${detailsBlock(p, { showAgenda: true })}
        <p style="margin-top:18px">${linkBtn(pass, "View request status")}</p>`;
      break;
    case "approved":
    case "moved":
      subject = kind === "moved" ? `Session updated — ${e.title} · ${when}` : `You're confirmed — ${e.title} · ${when}`;
      headline = kind === "moved" ? "Your session has been updated" : "You're confirmed!";
      pre = `${when} at ${v.name}, ${v.city}. Show the QR at reception.`;
      body = `<p>Hi ${first},</p><p>${kind === "moved" ? "Your Tech Week session details have changed (date, time or venue). Your seat is still confirmed — here are the updated details and a fresh calendar invite." :
        "Great news — your seat is confirmed for Tech Week."} Please show the QR code below at the reception for a quick check-in.</p>
        ${await qrBlock("Your entry pass")}
        ${detailsBlock(p, { showAgenda: true })}
        <p style="margin-top:18px">${btn(pass, "Open my pass")}${linkBtn(v.map_url, "Directions")}</p>
        <p style="font-size:13px;color:${MUTED}">A calendar invite is attached. If you can no longer attend, please cancel from your pass page so the seat can go to another partner.</p>`;
      addIcs();
      break;
    case "waitlisted":
      subject = `You're on the waitlist — ${e.title} · ${when}`;
      headline = "You're on the waitlist";
      pre = "This session is currently full. We'll notify you if a seat opens.";
      body = `<p>Hi ${first},</p><p>Thank you for your interest. The session you chose is currently full, so we've placed you on the
        <strong>waitlist</strong>. If a seat opens up, we'll email you right away.</p>${detailsBlock(p)}
        <p style="margin-top:18px">${linkBtn(pass, "View status")}</p>`;
      break;
    case "promoted":
      subject = `A seat has opened — ${e.title} · ${when}`;
      headline = "Good news — a seat has opened";
      pre = "Your waitlisted request is now under review.";
      body = `<p>Hi ${first},</p><p>A seat has opened in your session and your request has moved from the waitlist to review.
        You'll receive your confirmation and QR pass shortly.</p>${detailsBlock(p)}`;
      break;
    case "rejected":
      subject = `About your Tech Week request — ${e.title}`;
      headline = "Update on your request";
      pre = "We're unable to accommodate this request.";
      body = `<p>Hi ${first},</p><p>Thank you for your interest in ${esc(e.title)}. Unfortunately, we're unable to accommodate your request
        for <strong>${esc(when)}</strong>.${r.reason ? ` <br><span style="color:${MUTED}">Note: ${esc(r.reason)}</span>` : ""}</p>
        <p>We'll keep you informed about upcoming Tech Week sessions in your city.</p>`;
      break;
    case "cancelled":
      subject = `Registration cancelled — ${e.title} · ${when}`;
      headline = "Your registration is cancelled";
      pre = "Your seat has been released.";
      body = `<p>Hi ${first},</p><p>Your registration for <strong>${esc(when)}</strong> at ${esc(v.name)}, ${esc(v.city)} has been cancelled
        and your seat released.${r.reason && r.reason !== "Cancelled by attendee" ? ` <br><span style="color:${MUTED}">Note: ${esc(r.reason)}</span>` : ""}</p>
        <p>We hope to see you at a future session.</p>`;
      addIcs(true);
      break;
    case "event_cancelled":
    case "session_cancelled":
      subject = kind === "event_cancelled" ? `Cancelled: ${e.title}` : `Session cancelled — ${e.title} · ${when}`;
      headline = kind === "event_cancelled" ? "This event has been cancelled" : "Your session has been cancelled";
      pre = `We're sorry — ${when} will not take place.`;
      body = `<p>Hi ${first},</p><p>We're sorry to let you know that ${kind === "event_cancelled" ? `<strong>${esc(e.title)}</strong>` : `your session on <strong>${esc(when)}</strong>`}
        at ${esc(v.name)}, ${esc(v.city)} has been <strong>cancelled</strong>. Your registration and entry pass are no longer valid.</p>
        ${r.reason ? `<p style="color:${MUTED}">${esc(r.reason)}</p>` : ""}
        <p>We apologise for the inconvenience and will share new dates with you as soon as they are planned. For anything urgent, simply reply to this email.</p>`;
      addIcs(true);
      break;
    case "reminder":
      subject = `Reminder: ${e.title} · ${when}`;
      headline = "See you soon!";
      pre = `Your session is on ${s.date_label}, ${s.time_label}.`;
      body = `<p>Hi ${first},</p><p>A quick reminder that your Tech Week session is coming up. Please keep this QR code ready at the reception.</p>
        ${await qrBlock("Your entry pass")}${detailsBlock(p)}
        <p style="margin-top:18px">${btn(pass, "Open my pass")}${linkBtn(v.map_url, "Directions")}</p>`;
      break;
    case "thankyou": {
      const ext = (p.settings?.feedback_url ?? "").trim();
      const base = (p.settings?.public_url ?? "").trim().split("?")[0];
      const fb = ext || (base ? `${base}?f=${r.pass_token}` : "");
      subject = `Thank you for attending ${e.title} — your certificate`;
      headline = "Thank you for joining us";
      pre = "Your certificate of attendance is attached.";
      const cert = r.checked_in ? await certBytes(r.pass_token) : null;
      if (cert) attachments.push({ filename: "Cavitak-Tech-Week-Certificate.pdf", content: b64(cert), type: "application/pdf" });
      body = `<p>Hi ${first},</p><p>Thank you for attending <strong>${esc(e.title)}</strong> at ${esc(v.name)}, ${esc(v.city)}.
        We hope the hands-on session was useful for your upcoming projects.</p>
        ${cert ? `<div style="border:1px solid #E6E8EB;border-radius:12px;padding:14px 16px;margin:16px 0;background:#FAFBFC">
          <div style="font-weight:700">🎓 Your certificate of attendance</div>
          <div style="font-size:13px;color:${MUTED};margin:4px 0 8px">Attached as a PDF · Certificate ID ${esc(r.cert_code)}</div>
          ${linkBtn(`${FN_URL}?cert=${r.pass_token}`, "Download certificate")}</div>` : ""}
        ${fb ? `<p><strong>How was the session?</strong> Two minutes of feedback helps us plan the next one.</p><p>${btn(fb, "Rate the session ★★★★★")}</p>` : ""}
        ${(p.settings?.followup_url ?? "").trim() ? `<p>${linkBtn(p.settings.followup_url, "Slides & resources")}</p>` : ""}
        <p>For demos, project support or pricing, simply reply to this email.</p>`;
      break;
    }
    case "noshow": {
      const fu = (p.settings?.followup_url ?? "").trim();
      const more = (p.next_slots || []).slice(0, 6);
      subject = `We missed you at ${e.title}`;
      headline = "We missed you today";
      pre = "Here's how to catch up.";
      body = `<p>Hi ${first},</p><p>We were sorry not to see you at <strong>${esc(e.title)}</strong> on ${esc(when)}.</p>
        ${fu ? `<p>You can catch up with the slides and resources here:</p><p>${btn(fu, "Slides & resources")}</p>` : ""}
        ${more.length ? `<p>Would another session suit you better? Upcoming sessions at ${esc(v.name)}:</p>
          <ul style="padding-left:18px;margin:0 0 12px">${more.map((x: any) => `<li>${esc(x.date_label)} — ${esc(x.label)}, ${esc(x.time_label)}</li>`).join("")}</ul>
          <p>Just <strong>reply to this email</strong> with the one you prefer and we'll move your seat.</p>` : `<p>Reply to this email and we'll let you know about the next session in ${esc(v.city)}.</p>`}`;
      break;
    }
    case "reminder_soon":
      subject = `Today at ${String(s.time_label).split(" – ")[0]}: ${e.title}`;
      headline = "See you in a couple of hours";
      pre = `${s.label} session today, ${s.time_label} at ${v.name}.`;
      body = `<p>Hi ${first},</p><p>Your session starts <strong>today, ${esc(s.time_label)}</strong>. Keep this QR ready at the reception — or scan the QR on the room screen and confirm with your email.</p>
        ${await qrBlock("Your entry pass")}
        <p>${btn(v.map_url, "Get directions")}${linkBtn(pass, "Open my pass")}</p>${detailsBlock(p)}`;
      break;
    case "invite": {
      const base = (p.settings?.public_url ?? "").trim().split("?")[0];
      const link = base ? `${base}?e=${encodeURIComponent(e.slug)}&src=invite&i=${r.invite_token}` : "";
      const list = (p.slots || []);
      const days: Record<string, any[]> = {};
      list.forEach((x: any) => { (days[x.local_date] = days[x.local_date] || []).push(x); });
      const sched = Object.keys(days).sort().map((k) => `<tr><td style="padding:5px 12px 5px 0;font-weight:600;white-space:nowrap;vertical-align:top">${esc(days[k][0].date_label)}</td><td style="padding:5px 0">${days[k].map((x: any) => `${esc(x.label)} · ${esc(x.time_label)}`).join("<br>")}</td></tr>`).join("");
      subject = `You're invited: ${e.title}`;
      headline = "You're invited";
      pre = `Hands-on partner training at ${v.name}, ${v.city}. Limited seats.`;
      body = `<p>Hi ${first === "Partner" ? "there" : first},</p>
        <p>We'd love to host you at <strong>${esc(e.title)}</strong> — a hands-on partner training at <strong>${esc(v.name)}</strong>, ${esc(v.city)}.</p>
        ${e.description ? `<p style="color:${MUTED}">${esc(e.description)}</p>` : ""}
        ${sched ? `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border:1px solid #E6E8EB;border-radius:10px;padding:12px 16px;background:#FAFBFC;font-size:14px">${sched}</table>` : ""}
        <p style="margin:16px 0 6px">Seats are limited to ${esc(String((list[0] || {}).capacity || ""))} per session and confirmed on approval. Pick the session that suits you:</p>
        <p>${btn(link, "Register now →")}</p>
        <p style="font-size:13px;color:${MUTED}">📍 ${esc(v.address).replace(/\n/g, ", ")}${v.map_url ? ` · <a href="${esc(v.map_url)}" style="color:${RED}">Map</a>` : ""}</p>`;
      break;
    }
    case "admin_new": {
      const cu = consoleUrl(p);
      subject = `New Tech Week registration — ${r.full_name} (${r.organization}) · ${v.city} · ${s.label} ${s.local_date}`;
      headline = r.status === "waitlisted" ? "New registration (waitlisted)" : r.status === "approved" ? "New registration (auto-approved)" : "New registration to review";
      pre = `${r.full_name}, ${r.organization} — ${when}`;
      const rows = [["Name", r.full_name], ["Designation", r.designation], ["Organisation", r.organization], ["Email", r.email],
        ["Mobile", r.phone], ["Source", r.source], ["Status", r.status],
        ["Seats", `${s.approved}/${s.capacity} approved · ${s.pending} pending`]]
        .filter(([, val]) => val !== null && val !== undefined && val !== "")
        .map(([k, val]) => `<tr><td style="padding:4px 12px 4px 0;color:${MUTED};font-size:13px">${k}</td><td style="padding:4px 0;font-size:14px">${esc(val)}</td></tr>`).join("");
      body = `<table role="presentation" cellpadding="0" cellspacing="0">${rows}</table>
        <div style="height:12px"></div>${detailsBlock(p)}<p style="margin-top:18px">${btn(cu, "Open console to approve")}</p>`;
      break;
    }
    default:
      throw new Error("Unknown email kind: " + kind);
  }
  if (!s) return { subject, html: shell(p, headline, body, pre), text: headline + "\n\n" + e.title, attachments };
  const text = `${headline}\n\n${e.title}\n${s.date_label}\n${s.label}: ${s.time_label}\n${v.name}${v.room_name ? " · " + v.room_name : ""}\n${v.address}\n${v.map_url ?? ""}\n${pass ? "\nYour pass: " + pass : ""}`;
  return { subject, html: shell(p, headline, body, pre), text, attachments };
}

async function send(p: any, m: Mail): Promise<string> {
  const fromName = p.settings?.from_name || "Cavitak Tech Week";
  const replyTo = p.settings?.reply_to || undefined;
  const to = p.outbox.to_email.split(/[,;]\s*/).filter(Boolean);
  // 1) Gmail / Workspace SMTP when configured (no DNS needed)
  const user = envGet("SMTP_USER"), pass = envGet("SMTP_PASS").replace(/\s+/g, "");
  if (user && pass) {
    const transport = nodemailer.createTransport({
      host: envGet("SMTP_HOST") || "smtp.gmail.com",
      port: Number(envGet("SMTP_PORT") || 465), secure: true, auth: { user, pass },
    });
    const info = await transport.sendMail({
      from: `"${fromName}" <${user}>`, to, replyTo, subject: m.subject, html: m.html, text: m.text,
      attachments: m.attachments.map((a) => ({ filename: a.filename, content: a.content, encoding: "base64", contentType: a.type })),
    });
    return info.messageId ?? "smtp";
  }
  // 2) Resend (needs a verified domain to reach anyone other than the account owner)
  const resendKey = envGet("RESEND_API_KEY");
  if (resendKey) {
    const fromEmail = p.settings?.from_email || "onboarding@resend.dev";
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: `${fromName} <${fromEmail}>`, to, reply_to: replyTo, subject: m.subject, html: m.html, text: m.text,
        attachments: m.attachments.map((a) => ({ filename: a.filename, content: a.content })),
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Resend ${res.status}: ${body?.message ?? JSON.stringify(body)}`);
    return body?.id ?? "resend";
  }
  throw new Error("No email provider configured yet (add SMTP_USER + SMTP_PASS, or RESEND_API_KEY).");
}
