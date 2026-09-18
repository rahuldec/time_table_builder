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
   - `VITE_ACADEMIC_API_BASE_URL` = `https://academic-api.odpay.in`
   - `VITE_ACADEMIC_API_TOKEN` = the school's OD3 API token
   - `VITE_ACADEMIC_ENTITY_ID` = the school's entity id
   - `VITE_ACADEMIC_SESSION` = the academic session, e.g. `2026-27`
   - (See `.env.example` for the same list.) Skip this if you're happy entering classes/subjects/teachers by hand instead.
3. Click **Deploy**.
4. Once it's live, you can connect your GoDaddy domain the same way you did for createassignment.in (Vercel → Project → Domains).

---

## How to actually use the app, once it's live

The app has 3 tabs at the top:

### 1. Setup
This is where you enter everything about your school, in order:
- **School settings** — working days, periods per day, which periods are breaks. Save this first.
- **Import from Academic API (OD3)** (optional) — pulls classes, sections, subjects, and their assigned teachers straight from the school's ERP, so you don't have to re-type them. Safe to run again later; it skips anything already imported.
- **Classes & sections** — e.g. Grade 6 - Ganges, Grade 7 - Yamuna, etc.
- **Subjects** — Math, Science, etc. Tick "Lab" for anything that needs two periods back-to-back (Computer, Science Lab).
- **Teachers** — names, and optionally a cap on how many periods/day or /week they can teach.
- **Rooms** (optional) — only needed if you have shared spaces like a single Computer Lab that multiple classes use.
- **What each class needs to study** — this is the real heart of it. One entry = "Grade 6-Ganges needs Math from Mrs. Sharma, 6 times a week." You add one of these for every subject every class studies. (Anything pulled in via the Academic API import lands here too, with a default periods/week you can adjust.)

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
