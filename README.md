# The Money Room

Your personal + business money tool, now a real app: private logins, live sync
between phones, and the Claude-powered statement analyser running through a
secure serverless function.

Stack: **Vite + React + Supabase (auth, database, live sync) + Netlify (hosting + one function).**

---

## What you're setting up (once)

There are three accounts involved. You probably have the first two already:

- **GitHub** — where the code lives. (username SimonHalliday)
- **Netlify** — hosts the app for free, deploys automatically when you push.
- **Supabase** — free database + logins + live sync.

Plus an **Anthropic API key** for the statement analyser.

Work top to bottom. Each step says what "done" looks like. Budget ~30–40 minutes.

---

## Step 1 — Get it running on your machine

In your WSL2 Ubuntu terminal:

```bash
cd ~                      # or wherever you keep projects
# (unzip money-room.zip here so you have a ~/money-room folder)
cd money-room
npm install
```

Done when `npm install` finishes with no red errors.

---

## Step 2 — Create the Supabase project

1. Go to **https://supabase.com** → sign in → **New project**.
2. Name it `money-room`, pick a region near you, set a database password (save it somewhere).
3. Wait ~2 min for it to spin up.
4. Left sidebar → **SQL Editor** → **New query**.
5. Open the file **`SUPABASE_SETUP.sql`** from this project, copy the whole thing in, and click **Run**.
   - Done when it says "Success. No rows returned."
6. Left sidebar → **Project Settings → API**. Copy two things:
   - **Project URL**
   - **anon public** key (the long one under "Project API keys")

---

## Step 3 — Tell the app about Supabase

In the `money-room` folder:

```bash
cp .env.example .env
```

Open `.env` and paste your two values in:

```
VITE_SUPABASE_URL=https://xxxx.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGci...
```

(Leave `ANTHROPIC_API_KEY` for Step 6.)

---

## Step 4 — Turn on email logins

Magic-link sign-in (no passwords) needs the right redirect URLs.

In Supabase → **Authentication → URL Configuration**:

- **Site URL**: `http://localhost:8888`
- **Redirect URLs** — add both:
  - `http://localhost:8888`
  - (you'll add your live Netlify URL here after Step 5)

Email login is on by default, so that's it.

Now run the app locally:

```bash
npm run dev
```

Open the local address it prints (usually `http://localhost:5173`).
Sign in with your email → check your inbox → tap the magic link → you'll land on
**"Start a new household"** → click it. You're in. 🎉

> Note: the **statement analyser** won't work yet on `npm run dev` because it needs
> the serverless function. That kicks in after deploy (or run `netlify dev` once
> you've done Step 6). Everything else works now.

---

## Step 5 — Put it on GitHub, then Netlify

Create the repo and push:

```bash
git init
git add .
git commit -m "The Money Room"
git branch -M main
git remote add origin https://github.com/SimonHalliday/money-room.git
git push -u origin main
```

(Create the empty `money-room` repo on github.com first if it doesn't exist.)

Then deploy:

1. **https://netlify.com** → sign in → **Add new site → Import an existing project**.
2. Pick GitHub → choose `money-room`.
3. Netlify reads `netlify.toml`, so build settings are already correct
   (build `npm run build`, publish `dist`). Click **Deploy**.
4. When it's live you'll get a URL like `https://something.netlify.app`.

Now go **back to Supabase → Authentication → URL Configuration** and:
- set **Site URL** to your Netlify URL, and
- **add** your Netlify URL to **Redirect URLs**.

(Keep the localhost ones too so local dev still works.)

---

## Step 6 — Add the Anthropic key (for the statement analyser)

1. Get a key at **https://console.anthropic.com** → API Keys → Create key.
2. In **Netlify → Site settings → Environment variables → Add a variable**:
   - Key: `ANTHROPIC_API_KEY`
   - Value: your key
3. Also add your two Supabase vars here so the production build has them:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
4. **Deploys → Trigger deploy → Deploy site** so it rebuilds with the variables.

Done. The analyser now works on your live site. The key stays server-side and
never reaches the browser.

---

## Step 7 — Share it with Kate

1. On your live site, go to **More → Your household** and read off the **Join code**.
2. Kate opens the same Netlify URL on her phone, signs in with her own email,
   and on the welcome screen taps **Join with a code** and enters it.

You're both now looking at the same data, syncing live. Add it to your home
screens (Share → Add to Home Screen) and it behaves like a normal app.

---

## Day-to-day

- Push changes any time: `git add . && git commit -m "..." && git push` → Netlify redeploys automatically.
- Your data lives in Supabase (Table editor → `households` → the `data` column).
- Free tiers are plenty for a household; nothing here costs money except Anthropic
  API usage, which for occasional statement analysis is pennies.

## If something's off

- **"Missing Supabase env vars"** in the console → your `.env` (local) or Netlify
  env vars (live) aren't set. Re-check Steps 3 and 6.
- **Magic link doesn't sign you in** → the URL you're using isn't in Supabase's
  Redirect URLs list (Step 4 / Step 5).
- **Statement analyser errors** → `ANTHROPIC_API_KEY` not set in Netlify, or you
  didn't redeploy after adding it.
- **Bank CSV not parsing well** → most banks let you export CSV; if a format trips
  it up, send me a (redacted) sample and I'll tune the prompt.
