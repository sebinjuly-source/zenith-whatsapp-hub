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

### ✅ Option A (CHOSEN, 19 Oct 2026; steps in section 4) — keep today's numbers on the hub, add **one new SIM on the official API** for bulk outreach *(recommended start)*
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

## 4. Option A in detail — your chosen route

**Decision (19 Oct 2026):** keep the Hotel number and Seema's number on the hub exactly as they are. Add **one new SIM**
that lives **only on Meta's Cloud API**, and use it for first messages to new candidates (bulk outreach).
Candidates reply to the new number. Their replies show up in the same hub inbox, lists, Board and pipeline.

**Why this helps you:** Seema's number stops carrying the ban risk of cold outreach. Volume can grow past
35/day officially (250 people/day at once, 2,000 after verification). The phone numbers you rely on for
guests and staff are never put at risk.

### Status (20 Oct 2026)
- Done: app ZenithWAHub (published / Live), business portfolio renamed **Zenith Suites**, business verification
  submitted (in review), number **+91 98801 39926** registered on the Cloud API (display name "Zenith Suites",
  tier 250/day), WhatsApp profile (address, email, website), privacy page, webhook connected, system-user token
  and secrets in Render (names listed in Notion → Secrets), hub number **`zenith-api`** live.
- Templates submitted for review: `chef_job_invite` and `job_followup` (Marketing), `visit_date_request` and
  `visit_reminder` (Utility). Meta's `hello_world` sample can't be sent from a real number (error 131058).
- Open: payment method (Meta locked retries for 24 h; use a card with auto-debit if UPI fails again), app icon.
- In the hub: Numbers → "Zenith Suites (Meta API)"; Inbox shows the 24 h window and a "Meta template…" button;
  lists / bulk / follow-ups ask for a Meta template on this number; Templates page lists and submits Meta templates.

### 4.0 Have this ready before you start (about 10 minutes)
- [ ] **A new SIM** (Jio/Airtel/Vi) in any phone, able to receive **SMS or calls**, and **never used on WhatsApp**.
      Keep it recharged: you need it again if Meta ever asks you to re-verify. Don't install WhatsApp with it.
- [ ] The **Facebook account** you use for the Zenith Suites page (an admin of the business).
- [ ] The exact **legal name** of the business as on the GST certificate, the **address**, and the
      **website** (it should show the same name and address).
- [ ] GST certificate PDF (or Udyam/shop registration), for verification in step 4.6.
- [ ] A debit or credit card for Meta billing (you enter it yourself, step 4.5).
- [ ] A **6-digit PIN** you choose for the number (two-step verification). Write it down somewhere safe.

### 4.1 Developer account and app (10 min)
1. Open **developers.facebook.com/apps** → log in with your Facebook account. If asked, register as a
   developer (verify your phone/email; accept the terms yourself).
2. **Create app** → app name: `Zenith WhatsApp Hub` → contact email: yours.
3. Use case: **"Connect with customers through WhatsApp"** (newer screens may say *Connect on WhatsApp*) → Next.
4. **Business portfolio:** choose **Zenith Suites** if it exists, otherwise create it with the legal name.
   → Create app.

### 4.2 WhatsApp Business account and test send (5 min)
1. In the app: **Use cases → Customize → Connect on WhatsApp → Quickstart → "Start using the API"**
   (API Setup page).
2. Select or create the **WhatsApp Business account** (name: Zenith Suites; category Hotel; short description).
3. Meta gives a free **test number**. Under *To*, add your own mobile, then press **Send message** to see a
   test "hello_world" arrive. This proves the account works. (Don't copy the temporary token; we use a
   permanent one.)

### 4.3 Add the new SIM as the real number (10 min)
1. API Setup → **Add phone number**.
2. **Display name:** `Zenith Suites`. It must clearly match your business, so plain "Zenith Suites" is the
   safest choice for approval. "Zenith Suites Careers" usually works too but can be sent for review.
   Category: Hotel. Time zone: Asia/Kolkata. Description: one line about the hotel.
3. Enter the new SIM's number with +91 → verify with the **SMS** (or voice) code.
4. Two-step verification: set your **6-digit PIN**.
5. Copy two numbers shown on the page (they're IDs, not secrets): **Phone number ID** and
   **WhatsApp Business account ID**. Send them to me in chat.
6. Display name status shows **Approved / Pending review**. Messages can be sent while it's pending; the name
   then shows only after approval.

### 4.4 Permanent access token (10 min). You do this; the token is a secret
1. Open **business.facebook.com/latest/settings** → **Users → System users** → **Add**. Name it `hub`,
   role **Admin**.
2. **Assign assets** → Apps → *Zenith WhatsApp Hub* → **Manage app (full control)**. Then WhatsApp
   accounts → *Zenith Suites* → **full control**. → Assign.
3. **Generate token** → app *Zenith WhatsApp Hub* → expiry **Never** → permissions
   `whatsapp_business_messaging`, `whatsapp_business_management`, `business_management` → Generate.
4. Copy the token **once**. Paste it straight into **Render → zenith-whatsapp-hub → Environment** as
   `META_TOKEN` (step 4.7). Don't send it in chat.

### 4.5 Payment method (5 min). You do this
**business.facebook.com → WhatsApp Manager → (⋮ / Overview) → Payment settings / Billing → Add payment
method** → card, INR. Without it, template (first) messages fail once the free allowance runs out.

### 4.6 Business verification (15 min of your time, Meta takes 1–7 working days)
**business.facebook.com/latest/settings → Security Centre → Start verification** → legal name, address,
phone, website → upload the GST certificate → confirm by email/phone/domain as offered.
- You **don't have to wait** for this to start: an unverified business can already message **250 new people
  a day** (more than our 35–50). Verification raises it to **2,000 a day**, allows up to 20 numbers instead of 2,
  and makes the display name more trustworthy.

### 4.7 Paste the secrets into Render (5 min). You do this
Render → zenith-whatsapp-hub → **Environment** → add:

| Name | Where it comes from |
|---|---|
| `META_TOKEN` | step 4.4 |
| `META_APP_SECRET` | developers.facebook.com → your app → **App settings → Basic → App secret** (Show) |
| `META_PHONE_NUMBER_ID` | step 4.3 (I can also set this one) |
| `META_WABA_ID` | step 4.3 (I can also set this one) |
| `META_VERIFY_TOKEN` | a random word I give you, used once to connect the webhook |

Save. Render restarts by itself.

### 4.8 What I build in the hub (about a day of work, then tested)
1. A **"Meta Cloud API" number type** next to the linked numbers. It appears in Numbers, Inbox, Lists, Board,
   Drafts, Activity and the AI tools like any other number (id e.g. `outreach`).
2. **Webhook** `https://zenith-whatsapp-hub.onrender.com/meta/webhook`: incoming messages and delivery
   statuses (sent / delivered / read / failed with Meta's reason), signature checked with the app secret,
   duplicates ignored.
3. **Templates:** synced from Meta. *Send to list* on the outreach number picks an approved template and fills
   name/role/salary per candidate. Free text is only allowed inside the 24-hour window, and the hub warns you
   otherwise.
4. **Quality rating and daily limit** on the number's card; a WhatsApp alert to you if quality drops.
5. **Files** (PDFs, images) uploaded to Meta before sending.
6. **Privacy policy page** at `/privacy`, which Meta needs before the app can go **Live** (step 4.9).
7. Tests for all of it, then a live test with your own phone.

### 4.9 Connect the webhook and go Live (10 min, together)
The hub already answers at `/meta/webhook` (live since 20 Oct). It accepts Meta's check only when the verify
token matches `META_VERIFY_TOKEN` in Render, so the order matters:
1. On **Use cases → Customize → Connect on WhatsApp → Step 2. Production setup → Configure Webhooks**, copy
   the **Verify token** Meta pre-fills (or type your own random word; letters and digits, no spaces).
2. **Render → zenith-whatsapp-hub → Environment → Add environment variable**: `META_VERIFY_TOKEN` = that
   exact word. Also add `META_APP_SECRET` (App settings → Basic → App secret → Show). **Save, rebuild and
   deploy**, and wait about 3 minutes until the Events tab says *Deploy live*.
3. Back on Meta: **Callback URL** = `https://zenith-whatsapp-hub.onrender.com/meta/webhook`; the verify token
   is the same word → **Verify and save**. Success: the button greys out and a **Webhook fields** list appears.
   "The callback URL or verify token couldn't be validated" means the word differs from Render, Render was
   still deploying, or the hub was asleep; wait a minute and try again.
4. In **Webhook fields**, find `messages` → **Subscribe** (only this one is needed).
5. Leave "Attach a client certificate" **off**.
6. The orange note "only test webhooks… until the app has been published" is expected. **App settings →
   Basic:** privacy policy URL `https://zenith-whatsapp-hub.onrender.com/privacy`, app icon, category Business
   → Save → switch **App mode: Live** (do this after step 4.8 builds the `/privacy` page). Until then, Meta
   sends no real incoming messages to the webhook.

### 4.10 First templates (I draft them, you submit; approval usually takes minutes to a few hours)
WhatsApp Manager → **Message templates → Create template**:

| Name | Category | Text (variables in {{ }}) |
|---|---|---|
| `chef_job_invite` | Marketing | Namaste {{1}} ji, Zenith Suites (Amrutha Halli, Bengaluru) ko *{{2}}* chahiye – immediate joining. Salary {{3}}. Interested hain to *Haan* reply karein. Call: 9353315601. – Zenith Suites HR |
| `visit_reminder` | Utility | Namaste {{1}} ji, aapka Zenith Suites visit {{2}} ko hai. Address: {{3}}. Koi problem ho to reply karein. – Zenith Suites HR |
| `job_followup` | Marketing | Namaste {{1}} ji, Zenith Suites ki *{{2}}* job abhi bhi open hai. Interested ho to reply ya call karein: 9353315601. – Zenith Suites HR |

Add a **Quick reply button** ("Haan, interested" / "Nahi") to the invite: replies are easier, and a tapped
button opens the free 24-hour window. There's no salary in the follow-up, as before.

### 4.11 How a day looks afterwards
1. Regular Claude makes the WorkIndia batch as now → `import_list` on account **`outreach`**.
2. `send_to_list` → drafts on the Board → **Approve all**. Each candidate gets the `chef_job_invite` template
   with their own name, role and salary. Cost ≈ ₹0.86 each.
3. Replies arrive in the hub on the outreach number. Everything after a reply (asking for a date, location,
   reminders) is **free for 24 hours** after each candidate message. Later reminders use the cheap Utility
   template.
4. Seema's number is used for conversations you choose to continue there. No more cold bulk from it.

### 4.12 Costs and limits at a glance
- First messages: Marketing template ≈ ₹0.78–0.86 each (check Meta's live rate card) → 50/day ≈ ₹1,300/month.
- Replies within 24 h: free. Utility reminders: a few paise, free inside an open window.
- Unverified: 250 new people/day, 2 numbers. Verified: 2,000/day, then 10K → 100K → unlimited automatically
  if quality stays good.
- Quality: blocks and reports lower it. Keep the invite relevant, offer "Nahi", never send twice without a reply.

### What I need from you, in order
1. Steps 4.1–4.3 done → send me the **Phone number ID** and **WABA ID**.
2. Steps 4.4, 4.5, 4.7 done (secrets pasted into Render by you) → tell me "done".
3. Start 4.6 (verification) whenever convenient. It runs in the background.
4. Then I build 4.8, we do 4.9 together, you submit the 4.10 templates, and we test with your phone.

---

## 5. Decision checklist
- [ ] Is Seema's number personal WhatsApp or the WhatsApp **Business** app? (matters only for Option B)
- [ ] Do you have GST / business registration under the name "Zenith Suites"?
- [ ] Display name for the new number ("Zenith Suites Careers"?)
- [ ] Budget OK at about ₹0.86 per first message (≈ ₹1,300/month at 50/day)?

---

### Sources
- Meta — Cloud API get started: https://developers.facebook.com/documentation/business-messaging/whatsapp/get-started
- Meta — Business phone numbers (eligibility, registration, 2-number cap until verified): https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/phone-numbers
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
