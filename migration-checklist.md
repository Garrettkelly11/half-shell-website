# Half Shell — GitHub Pages Migration Checklist

**Goal:** Move from Netlify to GitHub Pages and set up automated Toast API sync.  
**Prepared:** April 16, 2026  
**Migration complete.** Site is live at hsoysters.com. All steps below are done.

---

## Website Structure Audit

Files included in the repo:

| File / Folder | Description |
|---|---|
| `index.html` | Main nightly oyster menu (customer-facing) |
| `oyster.html` | Oyster explorer / detail page |
| `employee.html` | Staff-facing admin view |
| `user.html` | Oyster Passport sign-up and sign-in |
| `Oyster Overview.html` | Full oyster encyclopedia |
| `assets/` | Background images, logo, 48 oyster photos |
| `data/oysters.js` | Master oyster database (static, manually curated) |
| `tools/sync-toast-to-firebase.js` | Live Toast → Firebase sync script |
| `.github/workflows/sync-oysters.yml` | GitHub Actions workflow (15-min sync) |
| `tools/` | Dev utilities and tests (see README.md) |
| `.gitignore` | Excludes backups, Python scripts, node_modules |
| `README.md` | Project overview |

Files **excluded** from the repo (via `.gitignore`):
- `*.bak.*` — backup snapshots
- `*.py` — Python dev tools
- `CONTINUE.md` — dev notes
- `sync-state.json` — runtime state (auto-generated)
- `node_modules/`

---

## Migration Steps

### A. GitHub Setup (you do these — ~10 minutes)

- [x] Go to [github.com](https://github.com) and sign in
- [x] Create a new public repository named `half-shell-website`
  - Click the **+** icon → "New repository"
  - Name: `half-shell-website`
  - Visibility: **Public** (required for free GitHub Pages)
  - Do **not** initialize with README (we have one already)
  - Click "Create repository"
- [x] On your laptop, open Terminal (or Git Bash / PowerShell) and navigate to the website folder:
  ```
  cd "C:\Users\gkell\OneDrive\Career\Half Shell\Oyster Management\Oyster Website"
  ```
- [x] Initialize git and push:
  ```
  git init
  git add .
  git commit -m "initial commit: half shell website"
  git branch -M main
  git remote add origin https://github.com/YOUR_USERNAME/half-shell-website.git
  git push -u origin main
  ```
  *(Replace `YOUR_USERNAME` with your GitHub username)*

- [x] Enable GitHub Pages:
  - Go to your repo on GitHub → **Settings** → **Pages**
  - Under "Build and deployment", set Source to **Deploy from a branch**
  - Branch: `main` | Folder: `/ (root)` → click **Save**
  - Wait 2–3 minutes, then your site will be live at:
    `https://YOUR_USERNAME.github.io/half-shell-website`

---

### B. GitHub Secrets for Toast Sync (you do these — once you buy Toast API access)

- [x] Purchase Toast Standard API Access from the **Toast Shop** (self-serve, read-only)
- [x] Get your credentials: `clientId`, `clientSecret`, and your Restaurant GUID
- [x] In your GitHub repo: **Settings** → **Secrets and variables** → **Actions**
- [x] Add three secrets (click "New repository secret" for each):

  | Secret Name | Value |
  |---|---|
  | `TOAST_CLIENT_ID` | Your Toast client ID |
  | `TOAST_CLIENT_SECRET` | Your Toast client secret |
  | `TOAST_RESTAURANT_GUID` | Your restaurant's GUID |

- [x] Identify the exact Menu Group name for oysters in Toast back-of-house (e.g., "Today's Oysters", "Raw Bar")
- [x] Configure Toast menu group name in `tools/sync-toast-to-firebase.js` (reads "Food Menu > Raw Bar")
- [x] Manually trigger a test sync: go to repo → **Actions** → "Sync Oyster Menu from Toast" → **Run workflow**
- [x] Confirm `/menu/serving` in Firebase updated with live oysters

---

### C. Custom Domain ✓ Live at hsoysters.com

Domain is registered and pointing at GitHub Pages. `CNAME` file in repo contains `hsoysters.com`.

---

### D. Turn Off Netlify (after GitHub Pages is confirmed working)

- [x] Confirm the GitHub Pages site is live and looks correct
- [x] If you had a custom domain on Netlify, transfer it to point at GitHub Pages first
- [x] Log into Netlify → your site → **Site settings** → scroll down → **Delete this site**
- [x] Cancel any Netlify paid plan if applicable

---

### E. End-to-End Toast Sync Test (after Toast credentials are added)

- [x] Visit your live GitHub Pages URL and confirm the site loads
- [x] Go to GitHub → **Actions** → "Sync Oyster Menu from Toast" → **Run workflow** (manual test)
- [x] Confirm the workflow completes without errors (green checkmark)
- [x] In Toast back-of-house, mark one oyster as out of stock (86 it)
- [x] Wait up to 15 minutes for the next auto-sync
- [x] Confirm the oyster disappears from the website

---

## Gotchas & Notes

**GitHub Actions rate limits:** GitHub Actions is free for public repos. The 15-minute sync runs ~96 times/day — well within free tier limits.

**Toast API timing:** After purchasing Standard API access, Toast says 1–3 business days for credentials. Budget time for this.

**Zero-oyster safety guard:** `tools/sync-toast-to-firebase.js` skips the Firebase write if Toast returns 0 oysters, so the last good list stays live if Toast has an error.

**Domain timing:** If you want the custom domain live for opening night, register it at least 48 hours in advance to allow DNS propagation.

---

## Repo

`https://github.com/Garrettkelly11/half-shell-website` — `main` branch deploys to GitHub Pages automatically.
