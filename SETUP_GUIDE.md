# Timetable Builder

A web app that auto-generates school timetables, then lets you view and adjust them.

You don't need to understand the code to get this running. Just follow the steps below in order — it's the exact same kind of process you used for createassignment.in and ODTED.

---

## What you're actually setting up (in plain words)

Three things, working together:

1. **Supabase** — this is your database. It's where all your subjects, teachers, classes, and the generated timetable get stored. Think of it as a very smart Excel sheet in the cloud.
2. **GitHub** — this is where the code lives. You already know this part: paste files in, commit, done.
3. **Vercel** — this takes the code from GitHub and turns it into a live website, automatically, every time you commit.

The website talks to the database using two secret keys (a URL and an API key), which you'll get from Supabase and paste into Vercel. That's the only "technical" step.

---

## Step 1 — Create the database (Supabase)

1. Go to [supabase.com](https://supabase.com) and create a new project (same as you did for ODTED).
2. Once it's created, open the **SQL Editor** (left sidebar).
3. Open the file `schema.sql` from this folder, copy everything in it, paste it into the SQL Editor, and click **Run**.
   - This creates all the tables: schools, classes, subjects, teachers, rooms, and the timetable itself.
4. Go to **Project Settings → API**. You'll see two values you need:
   - **Project URL** (looks like `https://xxxxx.supabase.co`)
   - **anon public key** (a long string)
   - Keep this tab open, you'll need to paste these in Step 3.

## Step 2 — Push the code to GitHub

1. Create a new repository on GitHub (e.g. `timetable-builder`).
2. Using the GitHub browser editor (your usual workflow): upload/paste in all the files from this project, keeping the same folder structure (the `src` folder, `package.json`, etc.).
3. Commit to `main`.

## Step 3 — Deploy on Vercel

1. Go to [vercel.com](https://vercel.com) → **Add New → Project** → import the GitHub repo you just created.
2. Before clicking Deploy, open **Environment Variables** and add these two (using the values from Step 1):
   - `VITE_SUPABASE_URL` = your Project URL
   - `VITE_SUPABASE_ANON_KEY` = your anon public key
3. Click **Deploy**.
4. Once it's live, you can connect your GoDaddy domain the same way you did for createassignment.in (Vercel → Project → Domains).

---

## How to actually use the app, once it's live

The app has 3 tabs at the top:

### 1. Setup
This is where you enter everything about your school, in order:
- **School settings** — working days, periods per day, which periods are breaks. Save this first.
- **Classes & sections** — e.g. Grade 6 - Ganges, Grade 7 - Yamuna, etc.
- **Subjects** — Math, Science, etc. Tick "Lab" for anything that needs two periods back-to-back (Computer, Science Lab).
- **Teachers** — names, and optionally a cap on how many periods/day or /week they can teach.
- **Rooms** (optional) — only needed if you have shared spaces like a single Computer Lab that multiple classes use.
- **What each class needs to study** — this is the real heart of it. One entry = "Grade 6-Ganges needs Math from Mrs. Sharma, 6 times a week." You add one of these for every subject every class studies.

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

- **Manual drag-and-drop editing** of a generated timetable (right now, editing means tweaking Setup and regenerating)
- **Printing/exporting** the timetable as PDF
- **Multiple schools** sharing one deployment (right now it assumes one school per deployment, same as your other single-tenant tools)

Tell me which of these you want next and we'll build it the same way.
