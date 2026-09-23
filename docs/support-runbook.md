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
| **Waiting for the original cashier to sign in** | Someone else recorded these; the app will not submit them under your name | Have that person sign in on this device |

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
uptime). If none fired, the outage is probably client-side.

### Symptoms

**"Auth not configured"** — the deployed bundle was built without
`VITE_FIREBASE_*`. The deploy now refuses to ship that, so it means an old
cached bundle. Have them hard-reload or clear site data.

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
(common, benign, clears within 24h) or a modified device (rare, deliberate).
**If no price changed recently, look at the device.**

### Catalog changes

```bash
python -m scripts.import_catalog <csv> \
  --base-url https://ultimate-bookkeeping-v2.web.app \
  --outlet-id <uuid> --email admin@ultimatebookkeeping.dev --apply
```

Dry run first without `--apply`. Idempotent by SKU. Add `--restock` to bring
stock to the CSV's quantities. Takes ~15 minutes for a full catalog — it is
paced under the server's 30/minute write limit.

A price change takes up to 24 hours to reach a device, because the service
worker caches the product list. Tell the owner that when they ask why the
till still shows the old price.

### Escalation

| Situation | Action |
|---|---|
| One device misbehaving | Hard reload, then clear site data |
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

**PITR clone, timed separately on the same day:** 12:00:07Z to 12:21:50Z,
**21m 43s** as a single operation — no target instance to create first. Its
data was checked with the same query below and matched production exactly:
213 products, 181 stock levels, 183 movements, 35,967 units, 1 sale, schema
`3defd5228372`.

| Path | Time to a reachable, verified database |
|---|---|
| PITR clone | **21m 43s** (one command) |
| Backup restore | **27m 36s** (two commands: create, then restore) |

So the clone is faster, but by about **six minutes** — not the order of
magnitude the shape of the commands suggests. Instance provisioning dominates
both; the clone just folds it into one step. **Choose on recovery point, not
on speed:** the clone can target any moment in the last 7 days, while a
backup restore can only give you 02:00 UTC. That difference is worth a day's
takings. The six minutes is not.

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

**Then repoint the app.** The restored instance has a different connection
name, so:

1. Add a new `database-url` secret version with the new host.
2. Update `CLOUD_SQL_CONNECTION_NAME` in GitHub secrets.
3. Redeploy — the migration step is a no-op on an already-migrated restore.
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
