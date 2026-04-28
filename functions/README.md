# Half Shell — Cloud Functions

Firebase Cloud Functions for syncing the oyster menu from Toast POS.

## What's here

| File | Purpose |
|---|---|
| `index.js` | Cloud Functions entry points — HTTP handlers + scheduled sync |
| `sync-toast-endpoint.js` | Core sync logic (auth, menu fetch, Firebase write) |
| `toast-mapping.js` | Toast GUID → Half Shell slug fallback table |
| `package.json` | Function dependencies (`firebase-functions`, `firebase-admin`, `dotenv`) |

## Functions deployed

| Function | Trigger | Purpose |
|---|---|---|
| `syncToastMenu` | HTTPS | Called by employee.html "Sync Toast" button. Returns list, no writes. |
| `syncToastMenuAutomatic` | HTTPS | Force-write sync to Firebase (admin/debug). |
| `scheduledToastSync` | Scheduled | Runs every 15 min during service hours (11am–11pm ET). Writes to `/menu/serving`. |

## First-time setup

Run each step from the `functions/` directory unless noted.

**1. Install Firebase CLI** (once per machine):

```bash
npm install -g firebase-tools
firebase login
```

**2. Install dependencies**:

```bash
npm install
```

**3. Configure Toast credentials**. Secrets go to Google Secret Manager (not in code):

```bash
firebase functions:secrets:set TOAST_CLIENT_SECRET
# paste the secret when prompted
```

Non-secret config uses environment parameters. Create a `.env.half-shell-oyster-menu` file in the project root (see `.env.example` in the parent folder):

```
TOAST_CLIENT_ID=pLQtDvjJJSw4HPgwFp2F9QEVuWYn9SlB
TOAST_LOCATION_ID=303485
TOAST_API_HOSTNAME=https://ws-api.toasttab.com
TOAST_USER_ACCESS_TYPE=TOAST_MACHINE_CLIENT
TOAST_OYSTER_GROUP_NAME=Oysters
```

**4. Upgrade Firebase project to Blaze plan** (pay-as-you-go). Required for Cloud Functions. Free tier covers ~2M invocations/month. At 15-min cron + manual button, expected cost is ~$0/month.

Go to the Firebase console → project settings → billing.

**5. Discover your Toast menu structure** — run the probe locally:

```bash
cd ..  # back to Oyster Website root
node tools/toast-probe.js
```

Look at the output for:
- The exact name of your oyster menuGroup (set `TOAST_OYSTER_GROUP_NAME` or `TOAST_OYSTER_GROUP_GUID`).
- Whether items have `externalId` set. If yes, you're done. If not, fill in `toast-mapping.js` with Toast GUID → Half Shell slug pairs.

**6. Deploy**:

```bash
cd functions
npm run deploy
```

Firebase prints function URLs at the end. Confirm `syncToastMenu` URL matches what `employee.html` calls (defaults to `https://us-east1-half-shell-oyster-menu.cloudfunctions.net/syncToastMenu`).

## Local development

```bash
npm run serve
```

Starts the Firebase Emulator at `http://localhost:5001/half-shell-oyster-menu/us-east1/syncToastMenu`. To point employee.html at the emulator, temporarily swap the `SYNC_URL` constant in employee.html.

## Updating credentials later

If Toast rotates the client secret:

```bash
firebase functions:secrets:set TOAST_CLIENT_SECRET
firebase deploy --only functions
```

Functions must be redeployed after changing secrets.

## Viewing logs

```bash
npm run logs
# or live:
firebase functions:log --only syncToastMenu
```
