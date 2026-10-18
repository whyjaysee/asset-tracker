# Net worth tracker

A two-page website (Overview and Update) for tracking household net worth month by month.
The data lives in the Supabase project "personal finance". Anyone you add can sign in with their
email and password (or a passkey) and enter numbers; nobody else can read or change anything.

Plain HTML and JavaScript: no build step, no server of your own.

This repository is public on purpose (free GitHub Pages). It contains only the website code: no figures, no history, no email addresses. Your data lives in Supabase behind sign-in.

## What's in the folder

| Path | What it is |
|---|---|
| `index.html`, `styles.css`, `js/app.js` | The website |
| `js/config.js` | Your Supabase address and public key (safe to publish; see Security) |
| `js/chart.umd.js`, `js/supabase.js` | Chart.js 4.4.7 and supabase-js 2.118.0, bundled so nothing loads from elsewhere |
| `supabase/001_setup.sql` | Not in this repository: it holds the imported history. Already run; keep your copy private |
| `supabase/002_shared_access.sql` | Sign-in access for household members. Run once (step 1) |
| `supabase/003_lockdown.sql` | Closes the whole project to the public key. Run before the site goes live (step 1) |
| `.github/workflows/keep-alive.yml` | Stops the free Supabase project pausing (step 4) |

## Setup

### 1. Lock down and turn on shared access (Supabase, about 2 minutes)
Run `supabase/003_lockdown.sql` first, then `002_shared_access.sql`.

1. Open `supabase/002_shared_access.sql` and replace the placeholder emails and names. Do this in the SQL Editor, not in the repository: this repository is public.
2. In Supabase, open the project, then SQL Editor, paste the file and run it.

To add or remove someone later, edit the `nw_members` table in the Table Editor.

### 2. Create the two sign-in accounts
Supabase dashboard, Authentication, Users, **Add user**, then **Create new user** for each email,
with a password and **Auto Confirm User** ticked. The site never creates accounts by itself.

To set or reset the password of an existing account, run this in the SQL Editor (not in the
repository), then delete the snippet so the password isn't kept in your SQL history:

```sql
update auth.users
set encrypted_password = extensions.crypt('NEW_PASSWORD', extensions.gen_salt('bf')),
    email_confirmed_at = coalesce(email_confirmed_at, now())
where email = 'YOUR_EMAIL_HERE';
```

For extra safety: Authentication, Sign In / Providers, turn off **Allow new users to sign up**.

### 3. Put the site online
Pick one. All are free for this.

This repository is published with GitHub Pages (Settings, Pages, deploy from the `main` branch, root folder). Each push to `main` redeploys within a minute or two.

### 4. Turn on passkeys
Supabase dashboard, Authentication, **Passkeys**: turn on passkey authentication and set

- Relying Party Display Name: `Net worth tracker`
- Relying Party ID: `whyjaysee.github.io`
- Relying Party Origins: `https://whyjaysee.github.io`

Passkeys are tied to that domain. If the site ever moves to another address, change these and
everyone adds a new passkey. Passkeys are in beta in Supabase, so the password stays as the
fallback.

### 5. Keep the database awake
Supabase pauses free projects after about a week with no activity, and a paused project makes the
site show "The database is not answering".

- If the folder is on GitHub, the included workflow pings it twice a week. Nothing to set up: it starts after the first push. Check the Actions tab once to confirm it ran.
- Otherwise, when it pauses, open the Supabase dashboard and choose **Restore project** (takes a few minutes).

## Working on the code
Clone the repository and open the folder in Cursor (or any editor). `AGENTS.md` explains how the
app fits together; Cursor and Claude read it automatically.

To preview locally, run `python3 -m http.server 5500` in the folder and open http://localhost:5500.
The local copy uses the live database. Push to `main` to publish.

## Using it
- Sign in with your email and password. Let Safari save them to iCloud Keychain and it fills them in with Touch ID or Face ID next time. You stay signed in after that.
- Optional: once signed in, choose **Add passkey** at the top; after that **Sign in with a passkey** needs no password. Passkeys work only on the live site, not on a local preview.
- Update: the five numbers that change each month are at the top; everything else is carried over from last month.
- The header shows who saved the latest month and when.

## Security
- The key in `js/config.js` is Supabase's public "anon" key. On its own it can only call `nw_ping()`.
- Every read and save goes through database functions that check the signed-in email against `nw_members`. The tables themselves are closed to the public key.
- Saves record the email that made them (`nw_months.updated_by`).
- The page asks search engines not to index it.
