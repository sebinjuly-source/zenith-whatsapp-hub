# Switch-over prompt for regular Claude (WorkIndia → WhatsApp Hub)

Paste this into regular Claude — once at the start of a chat, or better, into the **Project instructions** of
the project where you do WorkIndia hiring, so it applies to every chat there. Everything up to the Excel stays
exactly as before (criteria, filters, scoring, unlocking, personalised messages). Only the sending, tracking and
follow-up part moves from the Excel macro to the WhatsApp Hub connector.

---

```
From now on, use the "WhatsApp Hub" connector for sending and tracking WorkIndia hiring outreach.
Keep the rest of my WorkIndia workflow exactly as it is (criteria, filters, scoring, unlock count
confirmation, personalised Hinglish messages, the Excel shortlist as my record). Only these steps change:

1. First call get_playbook and follow it (e.g. never pay candidates before joining → reject; new candidates
   before follow-ups).

2. De-duplication BEFORE unlocking (replaces comparing with old Excel files): call
   known_candidates(role = "<the role, e.g. Chef>"). Exclude anyone in the WorkIndia pool who matches on
   name + location (or phone once known). Mention how many were excluded.

3. Name the batch: call list_lists(account = "hiring", role = "<role>") and use the next number,
   e.g. "Chef candidates – Batch 6". Each job role is its own role ("Chef", "Front office", "Housekeeping",
   …) so its lists, tasks and log stay separate.

4. After unlocking and writing the messages: still build the Excel for my records, but do NOT create the
   send macro. Instead call import_list with:
     account "hiring", name "<Role> candidates – Batch N", role "<Role>", source "WorkIndia <date>",
     members: one per candidate → { phone, name, message (their personalised message, real line breaks),
     row (priority rank), Location, Level, Cuisine/Niche, Experience (yrs), Score, Notes }.
   Report imported / skipped (skipped = already contacted in an earlier batch, invalid number…).

5. Send: call send_to_list(list = "<that list>"). On the hiring number this saves the messages as drafts;
   tell me the count and that I approve them on the Board ("Approve N") — unless I said "send now", then
   after my go-ahead call approve_task(id) with the task number it returned.

6. Follow-ups: call set_followup(list, enabled = true, after_days = 2, max = 1, auto_send = true,
   text = "Namaste {first_name} ji, Zenith Suites (Amrutha Halli) se follow-up: upar wali *<ROLE>* job
   abhi bhi open hai (immediate joining).\nInterested ho to *REPLY* ya *CALL* karein: 9353315601.
   - Zenith Suites HR"). Never put a salary in follow-ups (each candidate's first message has their own).
   The hub sends follow-ups only after 21:00 on days without new outreach, max 5/day.

7. Later, when I ask "who replied?" / "where do candidates stand?":
   use pipeline(role) and list_members(list, status = "replied") — never read every chat.
   For each reply, read only that chat (get_messages, limit 10) if needed, then record it with
   update_list_member: stage (interested / date_given / visited / trial / selected / joined /
   no_show / not_interested / rejected), visit_at when they give a date (the hub then reminds them and
   puts a task on my Board), and a short outcome. Draft replies with send_message (they wait for my
   approval). Interested but no date → ask for the day and time they can come.

Keep outputs short and filtered (by role, list, status) to save tokens.
```

---

**Tip:** if you'd rather update the `workindia-hiring` skill itself, replace its Step 7–8 ("hand off to
bulk-whatsapp-outreach / deliver the macro") with points 2–6 above. The prompt does the same without editing
the skill.
