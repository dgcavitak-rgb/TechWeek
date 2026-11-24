// Cavitak Tech Week — personalised RSS ticker for the room screen / BrightSign ticker zone.
// GET /functions/v1/tw-ticker?d=<door code>  → RSS 2.0, welcome lines interleaved with the current session's attendees.
import { createClient } from "npm:@supabase/supabase-js@2";

const SB = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const x = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]!));
const ascii = (s: string) => s.replace(/[–—]/g, "-").replace(/·/g, "|").replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
const tidyOrg = (o: string) => String(o || "").replace(/\s+/g, " ").trim()
  .replace(/[,.\s]*(pvt\.?|private)?\s*(ltd\.?|limited|llp|inc\.?)\s*$/i, "").replace(/[,.\s]+$/, "").trim();

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const code = (url.searchParams.get("d") || "").trim();
  const plain = url.searchParams.get("ascii") === "1";
  const { data } = code ? await SB.rpc("tw__ticker", { p_code: code }) : { data: null };
  const d: any = data?.ok ? data : null;

  const title = d?.title || "Cavitak Tech Week";
  const base = [
    `Welcome to ${title} — we're delighted to have you with us${d?.venue ? " at " + String(d.venue).split(" — ")[0] : ""}${d?.city ? ", " + d.city : ""}`,
    "Please check in by scanning the QR code on the screen and entering your 6-letter entry code from this morning's email",
    d?.session ? `Now: ${d.session}` : "Morning 11:00 AM – 1:30 PM  ·  Evening 3:00 PM – 5:30 PM",
    "Explore BrightSign's latest players and digital signage solutions live in our hands-on demo zone",
    "Your certificate of participation will be emailed to you the morning after your session",
    "Need help? Our Cavitak team at the reception desk will be happy to assist you",
    "Thank you for being a valued Cavitak partner — enjoy the session!",
  ];
  // personal lines: "A warm welcome to Pankaj from Secutech Automation India"
  const people: any[] = d?.people || [];
  const personal = people.map((p) => {
    const org = tidyOrg(p.org);
    return `A warm welcome to ${p.name}${org ? " from " + org : ""}`;
  });
  // interleave: one or two names between each general line, so every name appears once per loop
  const lines: string[] = [];
  const per = Math.max(1, Math.ceil(personal.length / base.length));
  base.forEach((b, i) => { lines.push(b); lines.push(...personal.slice(i * per, i * per + per)); });

  const now = new Date().toUTCString();
  const items = lines.map((t, i) => {
    const s = x(plain ? ascii(t) : t);
    return `    <item><title>${s}</title><description>${s}</description><guid isPermaLink="false">tw-${i + 1}-${now.slice(17, 22)}</guid><pubDate>${now}</pubDate></item>`;
  }).join("\n");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${x(plain ? ascii(title) : title)}</title>
    <link>https://dgcavitak-rgb.github.io/TechWeek/</link>
    <description>Welcome ticker</description>
    <language>en-in</language>
    <lastBuildDate>${now}</lastBuildDate>
    <ttl>5</ttl>
${items}
  </channel>
</rss>
`;
  return new Response(xml, { headers: { "Content-Type": "application/rss+xml; charset=utf-8", "Cache-Control": "no-cache", "Access-Control-Allow-Origin": "*" } });
});
