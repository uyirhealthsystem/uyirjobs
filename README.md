# Uyir Nurse Registration

Collects nurse information statewide. Staff call each nurse and send them our WhatsApp chat link by SMS from their own phone; the nurse messages us, gets their personal registration link on WhatsApp, opens it (no OTP), fills in their details, uploads documents and, once verified, adds bank details. Access is by district: each **District Admin** manages their own district, and the **Super Admin** manages every district plus staff accounts.

This is not a CRM: there is no outreach queue, lead assignment or onboarding pipeline. Admins call or SMS a nurse from their own phone and log the call status.

```
Not Invited ─admin calls, taps "SMS WhatsApp link"→ Invited ─nurse opens link, registers→ Registered (documents pending)
  ─nurse submits→ Submitted ─review→ Verified | Correction Required | Rejected
Correction Required ─nurse re-uploads→ Submitted        Verified → nurse adds bank details
```

The registration link is the nurse's only credential (long and random, never shown in full to anyone but staff), so it should not be shared. There is no SMS gateway: messages the app records as "SMS" or "WhatsApp" are logged as `simulated` until a provider is connected; the admin's own SMS is what actually reaches the nurse.

## Stack

| Part | Technology |
|---|---|
| API | **Express 5** (Node.js 22.13+), `server/` |
| Web app | **React 19** + React Router + TanStack Query, built with Vite, `web/` (staff app and the nurse portal `/register`, served by Express in production) |
| Database | **PostgreSQL on Amazon RDS** (Multi-AZ, TLS with the RDS CA bundle). Schema created / upgraded automatically on start |
| Documents | **Amazon S3**: private bucket, SSE-KMS, SHA-256 checksum on every upload; staff open files through 60-second presigned URLs |
| Hosting | ECS Fargate behind an ALB, deployed by GitHub Actions (`infra/`, `.github/workflows/deploy.yml`) |

```
server/
  src/index.js            start-up, graceful shutdown
  src/app.js              Express app: helmet (CSP/HSTS), logging, routes, React build
  src/config.js           environment, validated at start (bad production settings stop the process)
  src/routes/             auth, dashboard, nurses, documents, import, users, registration (nurse portal), whatsapp
  src/services/           nurses (status changes), messaging, inbound WhatsApp, whatsapp worker, storage (S3)
  src/middleware/         sessions + district scoping, CSRF origin check, rate limits, error handler
  src/domain/workflow.js  statuses, transitions, roles, document policy (single source of truth)
  src/db/                 pg pool, schema + in-place upgrades
  scripts/                seed, create-admin, migrate-from-sqlite, move-documents-to-s3
  test/                   end-to-end API tests (real PostgreSQL, WhatsApp and S3 stand-ins)
web/src/
  staff/                  sign-in, overview, nurse list, nurse detail, import, staff accounts
  register/               nurse portal: OTP → details → documents → bank details
```

## Run it locally

Requires Node.js 22.13+ and PostgreSQL 14+. Settings live in `.env` at the repository root (git-ignored; see `.env.example`).

```bash
npm run install:all     # server + web dependencies
npm run seed            # demo staff accounts (printed to the console)
npm run seed:demo       # optional: wipe nurse data and generate 44,000 SYNTHETIC nurses

# Development: two terminals
npm run dev:server      # API on http://localhost:$PORT (restarts on change)
npm run dev:web         # React on http://localhost:5173 (hot reload; /api proxied to the API)

# Production-style: Express serves the built React app
npm run build && npm start

npm test                # API tests; wipes and reuses TEST_DATABASE_URL (its name must contain "test")
```

Production-like stack with Docker (PostgreSQL + MinIO as S3 + the app image): `docker compose up --build`, then `docker compose run --rm app node scripts/seed.js`.

Demo accounts: `admin` / `Admin@123` (Super Admin), `tenkasi.admin` / `Tenkasi@123` and `chennai.admin` / `Chennai@123` (District Admins). First real Super Admin in production: `ADMIN_USERNAME=… ADMIN_PASSWORD=… npm run create-admin` (or the one-off ECS task in the deployment guide).

In development, uploaded documents are stored in `data/uploads` (`STORAGE_DRIVER=local`). In production they go to S3 (`STORAGE_DRIVER=s3`).

**Production (uyirjobs.in):** AWS ECS Fargate + RDS PostgreSQL + a private, KMS-encrypted S3 bucket, deployed by GitHub Actions on every push to `main` after the tests pass. Setup: [`docs/DEPLOYMENT-AWS.md`](docs/DEPLOYMENT-AWS.md).

## Production safeguards

- **Security:** HttpOnly + SameSite + Secure session cookies held in Postgres (any task can serve any request); cross-site requests refused by Origin check; strict CSP, HSTS and other helmet headers; rate limits on sign-in, the nurse portal and OTPs; async scrypt passwords with constant-time checks; bank account numbers AES-256-GCM encrypted; OTP codes and secrets never stored or logged (log redaction).
- **Uploads:** multipart, 5 MB limit, the file type is taken from the file's bytes (not the browser's claim), written to S3 before the database row so a row never points at a missing object.
- **Reliability:** status changes lock the nurse row in a transaction; WhatsApp sends are queued and retried with backoff (`FOR UPDATE SKIP LOCKED`, safe across tasks); schema migration under an advisory lock; graceful shutdown on SIGTERM; `/healthz` for the ALB.
- **Observability:** JSON logs with a request ID per request (`X-Request-Id`), suitable for CloudWatch Logs Insights.

## Roles

| | District Admin | Super Admin |
|---|---|---|
| Sees | Own district only | All districts |
| Add nurses, CSV import | Own district | Any district |
| Send / resend registration links (one or bulk) | ✓ | ✓ |
| Edit name / mobile / source | ✓ | ✓ |
| Move a nurse to another district | — | ✓ |
| Review documents; Verified / Correction Required / Rejected | ✓ | ✓ |
| Do Not Contact and SMS / WhatsApp consent | ✓ | ✓ |
| Call / SMS from own phone (SMS has the WhatsApp link); log call status | ✓ | ✓ |
| Export CSV | Own district | Any / all districts |
| Staff accounts (create, change role or district, deactivate, reset password) | — | ✓ |

District scoping is enforced in SQL on the server, not just hidden in the UI. A District Admin account without a district cannot sign in, and changing someone's role or district ends their sessions so the new access applies at once.

## What's in it

| Area | Details |
|---|---|
| **Nurse records** | Nurse ID (`UYIR-NUR-000001`), name, mobile, district, source, status. CSV import has a validation dry run, +91 and spacing normalisation, duplicate-mobile detection and district-alias matching (Trichy, Tuticorin…). |
| **Registration link** | `/register?t=…` (mobile-first): OTP-verified mobile → email, address, taluk / block, qualification, council registration, employment, experience, full/part-time, preferred locations, service interests, required consent → documents (PDF/JPG/PNG, contents checked) → submit. Handles the correction loop. Bank details after verification. |
| **Documents** | Qualification, council registration, government ID; experience documents only when the nurse declares experience (`DOC_TYPES` / `REQUIRED_RULES` in `src/workflow.js`). Each is reviewed individually; **Verified** needs every required document verified. |
| **Bank details** | Collected after verification. The account number is encrypted at rest (`FIELD_ENC_KEY`); staff and exports only ever see the last 4 digits. |
| **SMS → WhatsApp** | Staff SMS a WhatsApp chat link from their own phone. When the person taps it and sends the pre-typed message, the app finds them (or creates a record for a new Indian number, with no district until they choose one in the form) and replies on WhatsApp with their personal registration link, once. Later updates (received, reminders, correction, rejected, verified) are on WhatsApp. Their message is their opt-in. Delivery status shows on the nurse page. Setup: [`docs/WHATSAPP.md`](docs/WHATSAPP.md). |
| **Overview** | Counts per status, registration progress, and (Super Admin) a sortable per-district table. |
| **History** | Every status change, SMS, document upload / view / review, consent change and note is logged per nurse with who did it and when. |

## Upgrading from the earlier CRM version

On startup the app converts old data in place and logs what it did: outreach statuses → **Not Invited**, link sent / interested → **Invited**, documents pending → **Registered**, account / training / active → **Verified**. History is kept, with a note on each record. State Admin becomes Super Admin; District Coordinators become District Admins; Verification and Calling accounts are **deactivated** (re-enable them as District Admins from Staff accounts if needed).

From the old SQLite file: `npm run migrate:sqlite` copies `data/crm.db` into an empty Postgres database and applies the same conversion. Then `npm run migrate:s3 -- --dry-run` and `npm run migrate:s3` move uploaded files into the bucket.

## Integration points (stubs in this prototype)

- **WhatsApp.** Built in; set `WHATSAPP_PROVIDER=meta` and the credentials in [`docs/WHATSAPP.md`](docs/WHATSAPP.md). Until then messages are recorded as `simulated`.
- **SMS (invite only).** Recorded as `simulated` until a DLT-registered SMS gateway is connected (see the end of [`docs/WHATSAPP.md`](docs/WHATSAPP.md)).
- **OTP.** In development the code is shown on screen and in the server log. In production it is only sent to the nurse (by WhatsApp by default).

## Before using real nurse data

- Set `NODE_ENV=production`, `PUBLIC_URL=https://…`, and a strong `FIELD_ENC_KEY`. Serve over HTTPS (cookies become `Secure`).
- Replace the demo accounts and passwords. Don't run `seed:demo` against real data: it wipes nurse records.
- Back up the PostgreSQL database and the documents (S3 versioning + replication in production).
- Review consent wording, retention and Do Not Contact handling against the DPDP Act and TRAI/DLT rules with your legal team.




===========================
Next, point Hostinger to the zone so Route 53 starts answering DNS for uyirjobs.in. After that comes the certificate.

1. Copy the 4 nameservers from Route 53

Go to Route 53 → Hosted zones → uyirjobs.in. Open the NS record; it lists 4 values like:
ns-1234.awsdns-12.org.
ns-567.awsdns-34.net.
ns-89.awsdns-56.com.
ns-1011.awsdns-78.co.uk.
While you're there, copy the Hosted zone ID (for example Z05XXXXXXXXXXXX). You'll need it in step 4.

2. Change the nameservers in Hostinger

1. Go to hPanel → Domains → uyirjobs.in → DNS / Nameservers.
2. Choose Change nameservers, then cus
3. Paste the 4 values without the trailing dot and save.

▎ If you use email on @uyirjobs.in, first copy its MX/TXT records from Hostinger's DNS zone into the Route
▎ 53 zone.

Check that the change has spread. It u occasionally up to 24 hours:
nslookup -type=NS uyirjobs.in 8.8.8.8
Move on once it shows the awsdns names

3. Request the SSL certificate

1. Go to Certificate Manager. Make sura Pacific (Mumbai) ap-south-1.
2. Choose Request → Request a public certificate.
3. Domain names: uyirjobs.in, then Addin.
4. Validation method: DNS validation, then Request.
5. Open the certificate and click Create records.
6. Wait for the status to become Issued, usually 5–30 minutes once the nameserver change has spread. Copy the ARN.

4. Send me the two values

Paste the Hosted zone ID and the certiatsApp business number if you have it.I'll fill in infra/prod.params.json. Then we'll continue with the bootstrap stack and GitHub setup for the first deploy.