# Support runbook

Two audiences. **Part 1** is for the outlet — plain language, printable, keep
it by the till. **Part 2** is for whoever at Tesseract picks up the phone.

Every behaviour below was checked against the code rather than assumed; where
the system has a genuine limitation it is stated rather than smoothed over.

---

## Part 1 — For the shop

### The sync banner

A small banner appears at the top of the screen when something needs
attention. It is the only place the app tells you about sync.

| What it says | What it means | What to do |
|---|---|---|
| *(nothing)* | Everything has reached the server | Nothing |
| **N items syncing** | Sales recorded, waiting for network | Nothing — it clears itself |
| **N item(s) failed to sync — resolve needed** | The server refused something | Tap it, see below |
| **Waiting for the original cashier to sign in** | Someone else recorded these; the app will not submit them under your name | Tap **Sign out** at the top, then have that person sign in on this phone |

### Who is signed in

The bar at the top of the screen shows the name of whoever is signed in, and
a **Sign out** button. That name matters: a sale is tied to the person who
rang it up, so if the banner mentions "another user", the name at the top is
who it is *not*.

If anything is still waiting to sync, signing out will ask you to confirm.
**Those sales are not deleted** — they stay on this phone and go up when that
person signs back in. But nobody else can send them, so hand the phone over
only when the banner is clear, unless that person is coming back.

### "N items syncing" is not a problem

That is the app working as intended. A sale is **saved on the phone the
moment you confirm it**, before it reaches the server. It syncs when there is
network.

**Your sales are not at risk while this shows.** Queued sales are never
deleted automatically, however long they sit.

### Selling with no network

Works: **ringing up sales, stock adjustments, expenses.** Keep trading
normally.

Does not work: **the Stock screen.** Stock counts are deliberately not
cached — a wrong stock number is worse than no number, because nothing
downstream corrects it. The POS still works; only that screen is unavailable.

The product list keeps working from what the phone last downloaded. If you
changed a price today and the phone has not been online since, it may sell at
the **old price**. That shows up in the daily price review and settles itself
once the phone reconnects.

### When something failed to sync

Tap the banner. For each item you get two choices:

- **Retry** — send it again, exactly as recorded. Use this if it failed
  because of network or a server problem.
- **Discard** — throw it away. Only for something that should never have been
  recorded, e.g. a sale rung up twice by mistake.
- **Record stock and resend** — appears only when a sale was refused because
  the stock records could not cover it. It shows exactly what it would
  correct, e.g. *"Milo 400g — sold 5, records showed 3. Would record +2."*
  Use it when the goods really did leave the shop and the shelf simply held
  more than the system knew. **It writes a stock correction in your name, so
  only use it if the stock was genuinely there.**

**Retry cannot change the sale.** If the details are wrong, discard it and
ring it up again correctly.

If you are unsure, **leave it and call** — a failed item sits there safely
until someone deals with it.

### Total outage — the app will not load at all

1. **Write sales on paper.** Product, quantity, price, how they paid, time.
2. **Keep the paper.** It is the only record until the app is back.
3. **Call the number below.**
4. When the app is back, ring the sales up from your notes.

> **Important, and please read this once.** A sale entered later is recorded
> on the day you enter it, **not the day it happened**. If Tuesday's sales are
> entered on Thursday, they appear as Thursday's takings. There is no way to
> back-date one. So keep the paper and tell whoever reconciles your books
> which day those sales really belong to.

### Who to call

```
Name:      ______________________________
Phone:     ______________________________
Hours:     ______________________________
Out of hours: ________________________________
```

Expect a reply within **one business day** for price and catalog changes.

### Things only Tesseract can do right now

- **Add a product, change a price, remove a product.** There is no screen for
  this yet — text or call and it is done within one business day.
- **Add or disable a user.**
- **Correct a sale.** Sales cannot be edited or deleted from the app.

---

## Part 2 — For Tesseract

### First question: is it them or is it us?

```bash
curl -sS -o /dev/null -w "%{http_code}\n" \
  https://ultimate-bookkeeping-v2.web.app/api/v1/me     # expect 401
```

**401** — the stack is healthy: Hosting, the `/api` rewrite, and Cloud Run all
answered. The problem is the device or the account.

**403 with an HTML body** — Cloud Run has lost `--allow-unauthenticated`.
Firebase Hosting attaches no identity token, so a private service refuses its
rewrite. The site loads and every API call fails. Fix: redeploy, or
`gcloud run services add-iam-policy-binding ultimate-bookkeeping-api
--member=allUsers --role=roles/run.invoker --region europe-west1`.

**000 / timeout** — Hosting or DNS. Check the Firebase console.

Also check alerts: three policies exist (API 5xx, Cloud SQL connections,
uptime). **But do not read silence as good news** — see below.

Alerts go to **two verified addresses**, and a real alert was confirmed
arriving at *both* on 2026-09-24 — not merely configured. One full mailbox or
one spam rule no longer hides an outage.

> **Alerting was tested end to end on 2026-09-24 and works.** A deliberately
> triggered policy opened an incident and the mail arrived at both
> destinations — Gmail and Yahoo — so delivery is proven per channel, not just
> for the project. Retest after any change to the channels or policies: config
> that has never fired is a hypothesis, not monitoring.
>
> **Check the channel is VERIFIED before trusting alert silence.** Cloud
> Monitoring does not deliver to an unverified email channel, and a channel in
> that state still reports `enabled: true` and still attaches to policies. The
> giveaway is that `verificationStatus` is *absent* rather than `VERIFIED` —
> this channel was in that state until 2026-09-24. API-created channels do not
> auto-verify the way Console-created ones do.
>
> ```bash
> TOKEN=$(gcloud auth print-access-token)
> curl -sS -H "Authorization: Bearer $TOKEN" \
>      -H "x-goog-user-project: ultimate-bookkeeping-v2" \
>   "https://monitoring.googleapis.com/v3/projects/ultimate-bookkeeping-v2/notificationChannels" \
>   | grep -E 'verificationStatus|email_address'
> ```
>
> Re-verify with `:sendVerificationCode` then `:verify`. The
> `x-goog-user-project` header is required — without it these endpoints return
> an HTML 404 rather than a real error.
>
> **Every channel created through the API starts unverified.** Confirmed on
> both channels this project has. Adding a backup destination the obvious way
> therefore produces a dead one that reports `enabled: true` and attaches to
> policies quite happily. Verify it, then fire a test alert and confirm the
> mail lands, before counting it as redundancy.
>
> **How to test alerting, and how not to.** Create a temporary policy on a
> metric you have confirmed is flowing (the uptime check works well: invert it
> to fire on success), attach the real channel, and **wait 15-20 minutes**. A
> 300s alignment period plus evaluation lag means nothing happens sooner.
>
> Do not use a short-window log-based probe. Two such tests here reported no
> notification after ~150 seconds, once before the channel was verified and
> once after — the second proves the method was at fault, not the pipeline.
> Those two false negatives were briefly written up in this runbook as a
> week-long alerting outage. There was never evidence for that. Leave the test
> policy in place until the result is read, too: deleting it takes its
> incident record with it, which is the evidence.

### Symptoms

**"Auth not configured"** — the deployed bundle was built without
`VITE_FIREBASE_*`. The deploy now refuses to ship that, so it means an old
cached bundle. Have them hard-reload first; only clear site data after
checking the banner (below).

> ### Never clear site data while anything is unsynced
>
> **Clearing site data deletes the offline queue.** That queue is where sales
> rung up without network live, and this document says elsewhere that losing
> it is "the one genuine data-loss path" in the system. Clearing it destroys
> real takings that no other copy exists of — not a cache, not a session.
>
> **Before telling anyone to clear site data, have them read the banner:**
>
> | Banner shows | Safe to clear? |
> |---|---|
> | Nothing at all | Yes — everything has reached the server |
> | *N items syncing* | **No.** Get them online and wait for it to clear |
> | *N item(s) failed to sync* | **No.** Resolve each item on the Sync screen first |
> | *Waiting for the original cashier* | **No.** That person must sign in and let it drain |
>
> A hard reload is always safe and fixes a stale bundle on its own. Clearing
> site data is a separate, destructive step — treat it as a last resort and
> only on an empty banner.

**Signed in, but "ask your admin"** (`USER_NOT_PROVISIONED`) — the Firebase
account has no `users` row, or its uid is not a UUID. See the PROVISIONING
INVARIANT in `apps/api/app/auth.py`: `users.id` **must** equal the Firebase
uid, and a Console-created account gets a 28-character non-UUID uid that can
never match. Fix by recreating the Firebase user with an explicit `uid=`.

**"This app is for outlet managers"** — they signed in as the admin account.
Correct behaviour; have them use the manager account.

**Stock screen empty offline** — by design, not a fault.

**Sales stuck syncing for hours** — the device has no network, or the API is
down. Entries stuck in `syncing` self-heal after 2 minutes
(`STALE_SYNCING_MS`) and are re-dispatched; `client_id` makes that safe.

### What is safe to tell them

- **Queued sales are never lost to time.** The 48-hour retention window
  applies to *synced* and *discarded* entries only; unsynced money is
  explicitly exempt from pruning.
- **A retry cannot double-charge.** Every intent carries a `client_id`; a
  replay returns the original sale rather than writing a second one.
- **Losing the phone loses unsynced sales.** The queue is in that browser's
  storage. This is the one genuine data-loss path — if a device is lost with
  a full banner, those sales are gone.

### Daily price-variance review

```bash
cd apps/api && source .venv/bin/activate
python -m scripts.variance_report \
  --outlet-id <uuid> --email admin@ultimatebookkeeping.dev
```

A flag means a sale was priced away from the catalog. The POS has **no price
field**, so a cashier cannot mistype one. That leaves a stale catalog cache
(common, benign — it clears on the next catalog load, see below) or a modified
device (rare, deliberate). **If no price changed recently, look at the
device.**

A burst of flags right after a price change is expected and self-correcting:
sales rung up between the change and the device's next catalog refresh carry
the old price. A flag on a product whose price nobody touched is the one worth
following up.

### Catalog changes

**One product — a price change, a rename, a new min_stock.** This is a single
API call, not an importer run. Admin token required; the outlet manager
cannot do it.

```bash
curl -sS -X PATCH \
  -H "Authorization: Bearer $ADMIN_ID_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"outlet_id":"<uuid>","unit_price":"48.50"}' \
  https://ultimate-bookkeeping-v2.web.app/api/v1/products/<product_id>
```

Partial: fields you omit are left alone. Money is a NUMERIC(12,2) **string** —
`"48.50"`, never a float. A SKU that collides returns 409 `PRODUCT_SKU_EXISTS`;
a product belonging to another tenant returns 404, the same as one that does
not exist. Covered by `tests/test_products_write.py`.

**Whole catalog — a re-price, or first load.** That is the importer:

```bash
python -m scripts.import_catalog <csv> \
  --base-url https://ultimate-bookkeeping-v2.web.app \
  --outlet-id <uuid> --email admin@ultimatebookkeeping.dev --apply
```

Dry run first without `--apply`. Idempotent by SKU. Add `--restock` to bring
stock to the CSV's quantities. Takes ~15 minutes for a full catalog — it is
paced under the server's 30/minute write limit.

**How soon the till sees it.** The service worker caches the catalog with
Workbox **StaleWhileRevalidate**, which serves the cached copy *and* refreshes
it in the background on the same request. `useProducts` refetches on every POS
screen mount with no in-memory caching in front of it. So:

| Catalog load after the change | What the till shows |
|---|---|
| 1st | old price — and the cache is refreshed in the background |
| 2nd | **new price** |

In practice: have them leave the POS screen and come back, or reload. It is one
extra open, not a wait.

> **The "24 hours" in earlier versions of this runbook was wrong.** The
> `maxAgeSeconds: 86400` in the build is Workbox's cache *expiration* — when an
> entry is discarded for being too old, which only bites a device that has been
> offline that long and then has no catalog at all. It was never the staleness
> window. Stale-while-revalidate does not hold a response back for its max age.
>
> Verified from `vite.config.js`, `useProducts.js` and the generated `dist/sw.js`
> (`StaleWhileRevalidate`, `ub-products-cache`, `maxAgeSeconds:86400`). **Not yet
> watched on a real device** — confirm on the pilot phone the first time a price
> changes, and correct this table if it behaves differently.

### Escalation

| Situation | Action |
|---|---|
| One device misbehaving | Hard reload. **Check the sync banner before clearing site data** — see the warning below |
| Everyone affected, API 401 | Client-side; check the deploy |
| Everyone affected, API 403/timeout | Server-side; check Cloud Run and alerts |
| Data looks wrong | **Do not edit the database.** Reproduce, then fix in code |
| Suspected price manipulation | Run the variance report; `GET /sales/{id}` shows both prices per line |

### Disaster recovery — measured, not estimated

Two recovery paths, both verified against this instance on 2026-09-23.

**Point-in-time recovery.** Enabled. `pointInTimeRecoveryEnabled: True` with
`transactionalLogStorageState: CLOUD_STORAGE`, 7 days of logs. Recovery point
is **minutes**, not a nightly snapshot.

It was off until this drill found it. The instance carried
`transactionLogRetentionDays: 7`, which reads like PITR and is a different
setting entirely — inert without the flag. `clone --point-in-time` was
refused outright. Anyone auditing this later: check the flag, not the log
retention.

```bash
gcloud sql instances clone ubk-postgres ubk-recovered \
  --project ultimate-bookkeeping-v2 \
  --point-in-time 2026-09-23T11:58:00Z     # UTC, within the last 7 days
```

**Nightly backup restore.** Backups at 02:00 UTC, 7 retained. This path
restores into an instance that must already exist, so it is two operations:

```bash
gcloud sql backups list --instance ubk-postgres --project ultimate-bookkeeping-v2

gcloud sql instances create ubk-recovered --project ultimate-bookkeeping-v2 \
  --region europe-west1 --database-version POSTGRES_16 \
  --edition ENTERPRISE --tier db-f1-micro --storage-size 10GB

gcloud sql backups restore <BACKUP_ID> --restore-instance=ubk-recovered \
  --backup-instance=ubk-postgres --project ultimate-bookkeeping-v2
```

**Measured timings** (db-f1-micro, 10GB, europe-west1, ~600 rows):

| Step | Time |
|---|---|
| Create the empty target instance | 11m 55s |
| Restore the backup into it | 15m 41s |
| **Database restored and reachable** | **27m 36s** |
| Repoint `database-url` secret + redeploy | ~5-10m |
| **Realistic end-to-end RTO** | **~35-40 minutes** |

**PITR clone, timed twice on the same day — and the two disagree:**

| Run | Window | Duration |
|---|---|---|
| 1 | 12:00:07Z → 12:21:50Z | **21m 43s** |
| 2 | 17:37:51Z → 18:11:05Z | **33m 14s** |

Same instance, same size, same region, 50% apart. **Plan on the slower one.**
A single measurement of a cloud provisioning operation is an anecdote; if you
quote one number during an incident, quote 33 minutes. Run 1's data was checked
with the same query below and matched production exactly: 213 products, 181
stock levels, 183 movements, 35,967 units, 1 sale, schema `3defd5228372`.

| Path | Time to a reachable, verified database |
|---|---|
| PITR clone | **21m 43s** and **33m 14s** on two runs (one command) |
| Backup restore | **27m 36s**, measured once (create, then restore) |

An earlier version of this table claimed the clone is "about six minutes
faster". The second run was six minutes *slower* than the restore, so that
conclusion came from one sample and does not survive a second. The two paths
are the same order of magnitude and provisioning dominates both.

**Choose on recovery point, not on speed:** the clone can target any moment in
the last 7 days, while a backup restore can only give you 02:00 UTC. That
difference is worth a day's takings. The minutes are noise.

**Verified after restoring** — the restored copy matched production exactly:
213 products, 181 stock levels, 183 movements, 35,967 units, `sum(movements)`
equal to `stock_levels`, zero per-product mismatches, schema at
`3defd5228372`. A restore that completes but returns wrong data is worse than
one that fails, so check this, not just that the command exited 0:

```sql
select (select count(*) from products) as products,
       (select coalesce(sum(quantity),0) from stock_levels) as cached,
       (select coalesce(sum(delta),0) from stock_movements) as ledger;
-- cached must equal ledger
```

**Then repoint the app — rehearsed 2026-09-24, and simpler than it looks.**
The restored instance has a different connection name. That is the *only*
thing that changes:

1. Update `CLOUD_SQL_CONNECTION_NAME` in GitHub secrets, and
   `--set-cloudsql-instances` follows it in the workflow.
2. Redeploy. The migration step is a no-op on an already-migrated restore.

> **Do NOT create a new `database-url` secret version.** An earlier version of
> this runbook said to, "with the new host". The secret has no host in it:
>
> ```
> postgresql+asyncpg://ubk_app:<password>@/ultimate_bookkeeping
> ```
>
> The host comes from `CLOUD_SQL_CONNECTION_NAME` via
> `cloud_sql_connect_args()` in `app/db.py`, which builds the
> `/cloudsql/<connection-name>` unix socket path. A restore or clone carries
> the same database name, user and password, so the existing secret is already
> correct for it. Minting a new version mid-incident is a step that can only
> go wrong.
>
> **Rehearsed, not reasoned:** a clone of production was deployed to a
> throwaway Cloud Run service and the `alembic upgrade head` job run against
> it, same image, same service account, `database-url:latest` untouched, only
> the connection name changed. The job connected and exited 0 in 47s with no
> `Running upgrade` lines — confirming both that the unchanged secret works
> and that the migration really is a no-op. The throwaway service answered
> `/api/v1/me` with 401 and an unknown path with 404, the same shape as
> production.
>
> One honest limit: the database connection was proven through the migration
> *job*, which needs no auth. The *service* was not exercised against real
> data, because every route requires a Firebase token. The job uses the same
> image, service account, secret and socket mount, so the path is the same —
> but that last inch is inference, not measurement.

4. Set `--deletion-protection` on the new instance if you created it from
   scratch. A **clone inherits it** from the source along with the rest of the
   source's settings, which the drill confirmed the hard way — see below.

> **A clone inherits deletion protection, and that bites during recovery.**
> `ubk-pitr-probe` was cloned from `ubk-postgres`, which has protection on, so
> the probe came up with `deletionProtectionEnabled: True` and refused to be
> deleted. An instance created with `gcloud sql instances create` does not get
> it. This matters mid-incident: if a recovery attempt comes up wrong and you
> want to throw it away and retry, the delete is refused and you must clear
> the flag first, which is a separate operation that is itself rejected with
> HTTP 409 while any other operation on that instance is still running.
>
> ```bash
> gcloud sql instances patch <name> --no-deletion-protection --quiet
> gcloud sql instances delete <name> --quiet
> ```

**What is still untested:** restoring under real pressure, and the repoint
step above. The numbers here come from a rehearsal on a quiet system.
