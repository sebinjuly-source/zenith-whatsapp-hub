# Getting started with Meta's official WhatsApp API (Cloud API)

*For Zenith Suites / Zenith Dental Care — October 2026. Prices and limits change often; where sources
disagree this guide says so and tells you where to check.*

---

## 1. The short version

| | What you use today (WhatsApp Hub via linked device) | Meta's official API (Cloud API) |
|---|---|---|
| How it works | Your normal WhatsApp/WhatsApp Business app; the hub is a "linked device" (like WhatsApp Web) | Meta's servers send for you; your number is registered with Meta under your verified business |
| Cost | Free | Pay per message Meta sends **to start** a conversation (templates). Replies within 24 h of the customer's last message are free |
| How many | No official limit — but messaging strangers risks a **ban** (blocks/reports + an unofficial client) | 250 → 2,000 → 10,000 → 100,000 → **unlimited** unique people per 24 h, unlocked step by step |
| Ban risk | Real: unofficial client + cold outreach | No "unofficial client" risk. Your **quality rating** (blocks, reports) still matters — bad quality freezes or limits you, but it's managed, visible and recoverable |
| First messages | Any text | Must be a **pre-approved template** (you write it once, Meta approves it, you fill in name/role/salary) |
| Phone app | Keeps working normally | A number on the API **can't** also be used in the normal WhatsApp app — **except** with *Coexistence* (WhatsApp **Business** app + API on the same number, section 4) |

**There is no "unlimited and zero risk" option anywhere.** The official API is the closest: once you reach the
higher tiers you can message thousands of people a day with no risk of the number being banned for using an
unofficial tool — as long as people don't block or report you much.

---

## 2. How the Cloud API works (plain words)

1. **Business portfolio** (formerly Business Manager) at business.facebook.com → your verified business.
2. Inside it, a **WhatsApp Business Account (WABA)** → holds one or more **phone numbers**, each with an
   approved **display name** (e.g. "Zenith Suites Careers").
3. **Templates**: fixed messages with blanks, approved by Meta, e.g.
   *"Namaste {{1}} ji, Zenith Suites (Amrutha Halli) ko {{2}} chahiye – immediate joining. Salary {{3}}. Interested?
   Reply karein."* Categories: **Marketing** (job outreach, offers), **Utility** (interview time, booking
   confirmation, invoice, reminders tied to something the person did), **Authentication** (OTPs).
4. **24-hour customer service window**: when someone messages you, for 24 h you can send them **any** message,
   free (no template needed). After 24 h of silence you need a template again.
5. **Webhooks**: Meta sends every incoming message and every delivery status (sent / delivered / read /
   failed with a reason code) to your server — the WhatsApp Hub would receive these.
6. **Quality rating** (green / yellow / red) per number, based mostly on blocks and reports. It decides whether
   your sending limit can grow.

### Sending limits (per business portfolio, unique people per rolling 24 h, outside service windows)
- New portfolio: **250**.
- **2,000** after **business verification** (or after 2,000 good-quality template messages within 30 days).
- Then **10,000 → 100,000 → unlimited**, automatically within about 6 hours when your quality is good and you
  used at least half your limit in the last 7 days.
- All numbers in one portfolio share the limit.
- Replies inside the 24 h window don't count at all.

### What it costs (India, per message, charged when a template is delivered)
- **Marketing** (cold job outreach falls here): about **₹0.78–0.86** per message after Meta's January 2026
  increase. Sources disagree, and Meta announced another update from 1 October 2026, so check the live rate card.
- **Utility**: much cheaper (third-party figures range ₹0.115–0.35), and **free inside an open 24 h window**.
- **Service replies** (anything you send inside the 24 h window): **free**.
- Example: 50 job invites a day ≈ 50 × ₹0.86 ≈ **₹43/day ≈ ₹1,300/month**. All the back-and-forth after a
  candidate replies is free.
- **BSPs** (AiSensy, Interakt, WATI, …) add a monthly fee and/or 30–60% markup. **You don't need one**: the
  WhatsApp Hub can talk to Meta directly, so you pay Meta's rates only.

Check the live rates here: Meta's pricing page (developers.facebook.com → WhatsApp → Pricing), and WhatsApp
Manager → Insights for what you actually spent.

### Rules that matter for hiring
- **Opt-in**: Meta's policy expects people to have agreed to hear from you on WhatsApp. Candidates who applied
  or listed themselves on WorkIndia with their number are a grey zone. Keep the first message clearly relevant
  (job, place, salary), easy to refuse, and don't send cold messages repeatedly. Blocks and reports are what
  hurt your quality.
- First message = **Marketing template**. After they reply, chat freely for 24 h at no cost (send location, ask
  for a date, confirm interview).
- Interview reminders and booking confirmations can be **Utility** templates (cheap, often free).

---

## 3. Your options

### Option A — keep today's numbers on the hub, add **one new SIM on the official API** for bulk outreach *(recommended start)*
- Buy a new SIM (e.g. "Zenith Suites Careers"). Register it **only** on the Cloud API (it never goes into a
  phone app).
- Use it for **first messages to new candidates and bulk sends**: official, scalable (250 → 2,000 after
  verification → more), no ban risk from an unofficial tool.
- Keep Seema's number and the Hotel number on the hub as they are, for conversations, history, guests and staff.
- **Trade-off**: candidates reply to the new number. That's fine — the hub would show those chats in the same
  inbox, lists, board and pipeline, so you and the AI handle them as now.
- Cost: SIM + Meta per-message fees (about ₹1,300/month at 50 invites/day).

### Option B — **Coexistence** on an existing number (keep the phone app *and* use the API)
- Works only for numbers on the **WhatsApp Business app** (not personal WhatsApp). A personal number can first
  be switched to the WhatsApp Business app (chats are kept), then connected.
- Messages sent from the phone stay free; API messages are billed as above. Up to about 6 months of chat
  history can be shared into the API.
- **Limitations** (from provider documentation — confirm with Meta when you set it up):
  - no broadcast lists, disappearing messages, view-once media, live location or editing/deleting for
    everyone on that number
  - lower throughput
  - no blue tick, and standard business verification isn't available for coexistence accounts
  - the Business app must be opened at least every 13 days
  - can't move the number between WABAs
- Linking the same number to the hub *and* coexistence at the same time is untested territory. Plan to run a
  coexistence number through the API side of the hub only.
- Good for: the **Hotel number** later, if you want official sending for guests (booking confirmations,
  vouchers as Utility templates) while staff keep using the phone app.

### Option C — move an existing number fully to the API
- The number leaves the phone app entirely (no WhatsApp on that phone for that number). Highest throughput,
  verification and blue tick possible.
- Only sensible for a number that is purely for automated/team use. **Not recommended** for Seema's or the
  Hotel's main number.

### Option D — stay as you are (no Meta API)
- Free, works today, keeps everything on the phones.
- Ceiling: about 30–50 cold messages a day per number, with real ban risk if many people block or report.
  Spread outreach across numbers, keep messages relevant, prefer replies over cold sends.

**Suggested path:** Option A for hiring now → later, Option B for the Hotel number if you want official guest
messaging (vouchers, invoices, reminders as Utility templates).

---

## 4. Step-by-step: what you do vs. what I do

### You (one-time, about 1–2 hours plus Meta's review time)
1. **Business portfolio**: business.facebook.com → create or use "Zenith Suites" (use the exact legal name
   on your GST/registration).
2. **Business verification**: Security Centre → Start verification. Have ready: GST certificate (or
   registration/udyam), business address, a business phone/email, and the website zenithsuites… showing the
   same name and address. Takes about 1–7 working days. This unlocks the 2,000 tier.
3. **New SIM** (Option A) that is **not** on any WhatsApp app. Keep it in a phone that can receive an SMS or
   call for the one-time code.
4. **WhatsApp Manager** → Add phone number → display name (e.g. "Zenith Suites Careers"; must clearly relate to
   your business) → verify with the SMS/voice code.
5. **Payment method** in WhatsApp Manager → Billing (card/UPI as Meta allows; INR billing).
6. Tell me when it's done. The steps that involve entering secrets or payment details are yours. I'm not allowed
   to type passwords, tokens or card details into websites.

### Me (in the WhatsApp Hub)
1. Add **"Meta Cloud API" as a number type** next to today's linked numbers — same dashboard, inbox, lists,
   board, pipeline, rules and AI tools.
2. **Webhook** for incoming messages and delivery statuses, with Meta's signature check (fakes rejected) and
   duplicate protection (patterns borrowed from Chatwoot).
3. **Templates**: sync your approved templates from Meta; bulk sends and list sends pick a template and fill the
   blanks per candidate; free-form messages only inside the 24 h window (the hub warns otherwise).
4. Show **quality rating and current tier** on the number's card, and alert you if quality drops.
5. Upload files to Meta before sending (avoids one of Meta's rate limits) for PDFs, vouchers and images.
6. Draft your first templates for approval: a job invite (Marketing), an interview/visit reminder (Utility), and
   for the hotel later a booking confirmation and an invoice/voucher (Utility).

### What I'll need from you then
- In Meta's developer settings: a **System User access token** with WhatsApp permissions, the **phone number ID**,
  the **WABA ID** and the **app secret**. You paste these into Render's environment variables yourself (I'll give
  the exact names), same as you did for the database.

---

## 5. Decision checklist
- [ ] Is Seema's number personal WhatsApp or the WhatsApp **Business** app? (matters only for Option B)
- [ ] Do you have GST / business registration under the name "Zenith Suites"?
- [ ] Display name for the new number ("Zenith Suites Careers"?)
- [ ] Budget OK at about ₹0.86 per first message (≈ ₹1,300/month at 50/day)?

---

### Sources
- Meta — Messaging limits (2026): https://developers.facebook.com/documentation/business-messaging/whatsapp/messaging-limits
- Meta — Pricing: https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing.md
- India pricing analyses (figures differ, verify): https://baat.ai/blog/whatsapp-api-pricing-india ·
  https://hyperleap.ai/whatsapp-pricing-calculator-india · https://msg91.com/guide/whatsapp-business-pricing-update
- Messaging-limit guides: https://m.aisensy.com/blog/whatsapp-message-limits-guide/ ·
  https://msg91.com/guide/increase-whatsapp-messaging-tier-limits-your
- Template categories for hiring: https://recruitera.ai/blog/whatsapp-templates-utility-marketing-guide ·
  https://www.ycloud.com/blog/whatsapp-api-message-template-category-guidelines-update.md
- Opt-in for candidates: https://www.ashbyhq.com/product-updates/whatsapp
- Coexistence: https://docs.360dialog.com/partner/waba-management/whatsapp-coexistence ·
  https://www.wati.io/en/blog/whatsapp-coexistence-solution/ · https://help.seven.io/en/whatsapp/whatsapp-coexistence
- Setup in India: https://hyperleap.ai/whatsapp-business-api-setup-guide-india
