# Half Shell — GitHub Pages Migration Checklist

**Goal:** Move from Netlify to GitHub Pages and set up automated Toast API sync.  
**Prepared:** April 16, 2026

---

## Website Structure Audit

Files included in the repo:

| File / Folder | Description |
|---|---|
| `index.html` | Main nightly oyster menu (customer-facing) |
| `oyster.html` | Oyster explorer / detail page |
| `employee.html` | Staff-facing admin view |
| `User.html` | User profile page |
| `Oyster Overview.html` | Full oyster encyclopedia |
| `assets/` | Background images, logo, 48 oyster photos |
| `data/oysters.js` | Master oyster database (static, manually curated) |
| `public/oysters.json` | Live availability from Toast (auto-synced) |
| `sync.js` | Toast API polling script |
| `.github/workflows/sync-oysters.yml` | GitHub Actions workflow (15-min sync) |
| `tools/` | Dev utilities (generate_photo_map.js) |
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

- [ ] Go to [github.com](https://github.com) and sign in
- [ ] Create a new public repository named `half-shell-website`
  - Click the **+** icon → "New repository"
  - Name: `half-shell-website`
  - Visibility: **Public** (required for free GitHub Pages)
  - Do **not** initialize with README (we have one already)
  - Click "Create repository"
- [ ] On your laptop, open Terminal (or Git Bash / PowerShell) and navigate to the website folder:
  ```
  cd "C:\Users\gkell\OneDrive\Career\Half Shell\Oyster Management\Oyster Website"
  ```
- [ ] Initialize git and push:
  ```
  git init
  git add .
  git commit -m "initial commit: half shell website"
  git branch -M main
  git remote add origin https://github.com/YOUR_USERNAME/half-shell-website.git
  git push -u origin main
  ```
  *(Replace `YOUR_USERNAME` with your GitHub username)*

- [ ] Enable GitHub Pages:
  - Go to your repo on GitHub → **Settings** → **Pages**
  - Under "Build and deployment", set Source to **Deploy from a branch**
  - Branch: `main` | Folder: `/ (root)` → click **Save**
  - Wait 2–3 minutes, then your site will be live at:
    `https://YOUR_USERNAME.github.io/half-shell-website`

---

### B. GitHub Secrets for Toast Sync (you do these — once you buy Toast API access)

- [ ] Purchase Toast Standard API Access from the **Toast Shop** (self-serve, read-only)
- [ ] Get your credentials: `clientId`, `clientSecret`, and your Restaurant GUID
- [ ] In your GitHub repo: **Settings** → **Secrets and variables** → **Actions**
- [ ] Add three secrets (click "New repository secret" for each):

  | Secret Name | Value |
  |---|---|
  | `TOAST_CLIENT_ID` | Your Toast client ID |
  | `TOAST_CLIENT_SECRET` | Your Toast client secret |
  | `TOAST_RESTAURANT_GUID` | Your restaurant's GUID |

- [ ] Identify the exact Menu Group name for oysters in Toast back-of-house (e.g., "Today's Oysters", "Raw Bar")
- [ ] Update this line in `sync.js` to match your Toast naming:
  ```javascript
  const OYSTER_GROUP_NAMES = ['oyster', 'oysters', 'raw bar', 'half shell'];
  ```
- [ ] Manually trigger a test sync: go to repo → **Actions** → "Sync Oyster Menu from Toast" → **Run workflow**
- [ ] Confirm `public/oysters.json` updated with your live oysters

---

### C. Custom Domain (when you're ready — optional but recommended)

Since you don't have a domain yet, here are good options:

**Recommended domain names to check:**
- `halfshellcharlotte.com`
- `halfshellclt.com`
- `halfshellrawbar.com`
- `eathalfshell.com`

**Where to register:** [Namecheap](https://namecheap.com) (often ~$10–12/yr for .com) or [Cloudflare Registrar](https://cloudflare.com/products/registrar/) (at-cost pricing, no markup).

**Once you have a domain:**
1. Create a file called `CNAME` in the root of the repo containing only your domain, e.g.:
   ```
   halfshellcharlotte.com
   ```
2. Commit and push that file to GitHub
3. In GitHub repo → **Settings** → **Pages** → "Custom domain" field → enter your domain → Save
4. Log into your domain registrar and add DNS records:

   | Type | Host | Value |
   |---|---|---|
   | A | @ | 185.199.108.153 |
   | A | @ | 185.199.109.153 |
   | A | @ | 185.199.110.153 |
   | A | @ | 185.199.111.153 |
   | CNAME | www | YOUR_USERNAME.github.io |

5. DNS propagation takes up to 24 hours (usually faster)
6. Check "Enforce HTTPS" in GitHub Pages settings once the domain is verified

---

### D. Turn Off Netlify (after GitHub Pages is confirmed working)

- [ ] Confirm the GitHub Pages site is live and looks correct
- [ ] If you had a custom domain on Netlify, transfer it to point at GitHub Pages first
- [ ] Log into Netlify → your site → **Site settings** → scroll down → **Delete this site**
- [ ] Cancel any Netlify paid plan if applicable

---

### E. End-to-End Toast Sync Test (after Toast credentials are added)

- [ ] Visit your live GitHub Pages URL and confirm the site loads
- [ ] Go to GitHub → **Actions** → "Sync Oyster Menu from Toast" → **Run workflow** (manual test)
- [ ] Confirm the workflow completes without errors (green checkmark)
- [ ] In Toast back-of-house, mark one oyster as out of stock (86 it)
- [ ] Wait up to 15 minutes for the next auto-sync
- [ ] Confirm the oyster disappears from the website

---

## Gotchas & Notes

**GitHub Actions rate limits:** GitHub Actions is free for public repos. The 15-minute sync runs ~96 times/day — well within free tier limits.

**Toast API timing:** After purchasing Standard API access, Toast says 1–3 business days for credentials. Budget time for this.

**The `[skip ci]` tag:** The sync workflow commit message includes `[skip ci]` — this tells GitHub not to re-trigger the workflow when the bot commits `oysters.json`, preventing an infinite loop.

**Zero-oyster safety guard:** `sync.js` includes a safety check — if Toast returns 0 oysters (which could indicate an API error), it will NOT overwrite the existing `oysters.json` with an empty menu. Your existing data stays live until a valid non-empty response comes back.

**Domain timing:** If you want the custom domain live for opening night, register it at least 48 hours in advance to allow DNS propagation.

---

## Quick Push Command (when repo is created)

```bash
cd "C:\Users\gkell\OneDrive\Career\Half Shell\Oyster Management\Oyster Website"
git init
git add .
git commit -m "initial commit: half shell website"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/half-shell-website.git
git push -u origin main
```
