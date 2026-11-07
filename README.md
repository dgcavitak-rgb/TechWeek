# Cavitak Tech Week Console

One console to run partner training (Tech Week) across cities and experience centers.

- **Console:** open `index.html` (sign in)
- **Registration link:** `index.html?e=<event-slug>&src=<channel>`
- **Partner pass (QR):** `index.html?p=<pass-token>` (sent by email on approval)

## What it does
- Events per city / experience center, each with its own room capacity, dates, slots and time zone
- Shareable registration links tagged by channel (WhatsApp, email, LinkedIn, sales…), QR poster
- Approval inbox with live seats per session, bulk approve / waitlist / move / reject
- Automatic emails: received → confirmed (QR pass + calendar invite, date, slot, venue address + map) → waitlist / seat opened / rejected / cancelled / session changed → 24 h reminder → thank-you
- Phone-camera QR check-in, manual check-in, walk-ins
- Reports: attendee list (Excel), show-up rate, channel performance, target-partner coverage
- Roles: super, approver, check-in staff, marketing (contact details masked)

## Backend
Supabase project `cavitak-tech-week` (ap-south-1). Tables are locked; all access goes through
token-checked RPC functions. Email worker: edge function `tw-mailer` (source in `supabase/functions/tw-mailer`),
sending through Resend (`RESEND_API_KEY`) or Gmail/Workspace SMTP (`SMTP_USER`, `SMTP_PASS`).
Reminders, thank-you mails and email retries run every 10 minutes via pg_cron.
