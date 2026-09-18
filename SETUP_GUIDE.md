# Timetable Builder

A web app that auto-generates school timetables, then lets you view and adjust them.

You don't need to understand the code to get this running. Just follow the steps below in order — it's the exact same kind of process you used for createassignment.in and ODTED.

---

## What you're actually setting up (in plain words)

Two things, working together:

1. **GitHub** — this is where the code lives. You already know this part: paste files in, commit, done.
2. **Vercel** — this takes the code from GitHub and turns it into a live website, automatically, every time you commit.

There's no database to provision. Everything you enter — school settings, classes, subjects,
teachers, and every generated timetable — is saved directly in the browser you're using
(localStorage), not in a shared cloud database.

**Important tradeoff:** because there's no shared database, the data only exists in the one
browser, on the one computer, where it was entered. If a different staff member opens the site on
their own computer, they'll see a blank Setup page — they aren't looking at the same data. Clearing
that browser's site data (or switching browsers/devices) also wipes it. This is fine for a single
person running Setup + Generate from one machine; it is **not** fine if several people need to see
or edit the same timetable. If that's ever needed, say so and we can add a shared backend back in.

---

## Step 1 — Push the code to GitHub

1. Create a new repository on GitHub (e.g. `timetable-builder`).
2. Using the GitHub browser editor (your usual workflow): upload/paste in all the files from this project, keeping the same folder structure (the `src` folder, `package.json`, etc.).
3. Commit to `main`.

## Step 2 — Deploy on Vercel

1. Go to [vercel.com](https://vercel.com) → **Add New → Project** → import the GitHub repo you just created.
2. If you want the Academic API (OD3) import feature on the Setup page to work, open **Environment Variables** before deploying and add:
   - `ACADEMIC_API_BASE_URL` = `https://academic-api.odpay.in`
   - `ACADEMIC_API_TOKEN` = the OD3 API token (this one token can pull multiple entities/schools)
   - `ACADEMIC_SESSION` = the academic session, e.g. `2026-27`
   - `VITE_ACADEMIC_ENTITY_ID` (optional) = pre-fills the Entity ID field on Setup; you can still type a different entity id there per import.
   - (See `.env.example` for the same list.) Skip this if you're happy entering classes/subjects/teachers by hand instead.
   - **Note the first three have no `VITE_` prefix** — that's deliberate. The browser never talks to `academic-api.odpay.in` directly; it calls a small serverless function (`api/academic-subject-course-mapping.js`, included in this repo) which holds the token server-side and forwards the request. A `VITE_`-prefixed var gets baked straight into the JS bundle anyone can view — fine for the entity id (not a secret), not fine for a real access token.
3. Click **Deploy**.
4. Once it's live, you can connect your GoDaddy domain the same way you did for createassignment.in (Vercel → Project → Domains).

---

## How to actually use the app, once it's live

The app has 3 tabs at the top:

### 1. Setup
Setup is a horizontal strip of 9 sections — numbered pills at the top jump straight to any of
them, and `‹ ›` arrows (or swiping/scrolling) step through one at a time. Nothing is gated behind
an earlier step, and the **"Generate timetable →"** button stays visible underneath no matter which
section you're on.

1. **Import** (optional) — paste the **Entity ID** for the school you want and it fetches
   automatically (no button needed, though "Fetch & import" is there to re-run it). Pulls every
   class, section, subject, and assigned teacher straight from the school's ERP. Safe to run again
   later — for the same entity or a different one — it skips anything already imported.
2. **School settings** — working days, periods per day, which periods are breaks. Defaults to
   Mon–Sat / 8 periods if you don't touch it; adjust and save whenever.
3. **Class** — pick one class, and the Subjects and Teachers sections below narrow down to just
   what that class actually studies (instead of the school's full lists) — handy for reviewing one
   class at a time after a big import. It's a display filter only: toggling a subject on/off here
   still affects that subject everywhere it's used, not just this one class. Leave it on
   "All classes" to see everything, same as before.
4. **Subjects** — shows the subjects for whichever class is picked above (or all of them). Each has
   an **"In timetable"** toggle — scholastic subjects (English, Math, Science, …) default **on**,
   co-scholastic/discipline ones (Art Education, Work Education, Discipline, G.K., …) default
   **off**. You can also add a subject by hand and tick "Lab" for anything needing two periods
   back-to-back.
5. **Teachers** — same class filter as Subjects. Click "Unavailable slots" under a teacher to block
   off day/period combinations they can't teach, or cap their periods/day or /week.
6. **Classes & Sections**, 7. **Avoid back-to-back**, 8. **Rooms**, 9. **Requirements** — all filled
   in automatically by the import; open one only for a manual fix (a class the ERP doesn't have yet,
   keeping two teachers apart, a shared room, or a different periods/week count for one subject in
   the Requirements table).

### 2. Generate
Click one button. It reads everything from Setup and builds a complete clash-free timetable — no teacher or room double-booked. Takes a few seconds.

### 3. View Timetable
Switch between:
- **Class view** — see one class's full week
- **Teacher view** — see one teacher's full week (good for checking their workload)
- **Room view** — see who's using a shared room and when

---

## If you need to regenerate

If you add more teachers/subjects later, just go to Setup, add the new lesson requirements, then hit **Generate** again. It keeps a version number internally, so nothing gets silently overwritten — the View Timetable page always shows the latest version automatically.

---

## What's NOT built yet (next steps)

- **Shared/multi-device data** — right now everything lives in one browser's local storage (see the tradeoff above); a real shared backend would fix this
- **Manual drag-and-drop editing** of a generated timetable (right now, editing means tweaking Setup and regenerating)
- **Printing/exporting** the timetable as PDF
- **Multiple schools** sharing one deployment (right now it assumes one school per deployment, same as your other single-tenant tools)

Tell me which of these you want next and we'll build it the same way.
