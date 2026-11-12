# UyirJobs on AWS: high-availability design and deployment

## Deploy it (CI/CD)

Everything is code:

| File | What it is |
|---|---|
| `Dockerfile` | Production image (Node 24, non-root, RDS CA bundle baked in for verified TLS) |
| `infra/bootstrap.yml` | **One time:** ECR repository, GitHub OIDC provider, the GitHub deploy role (push images + deploy one stack, nothing else), and the CloudFormation execution role |
| `infra/app.yml` | **The app:** VPC over 2 AZs (NAT per AZ, S3 gateway endpoint), ALB with HTTPS (TLS 1.2+, HTTP→HTTPS), ECS Fargate service (2–6 tasks, rolling deploy with automatic rollback, CPU autoscaling), RDS PostgreSQL Multi-AZ (encrypted, 14-day backups, deletion protection), private **S3 documents bucket** (KMS, versioning, TLS-only, no public access), Secrets Manager (DB password, `FIELD_ENC_KEY`, WhatsApp), CloudWatch logs and optional alarms |
| `infra/prod.params.json` | Non-secret production settings, committed to git |
| `.github/workflows/deploy.yml` | Pipeline: tests (real PostgreSQL) + infrastructure lint on every push and PR; on `main`: build → push to ECR → `cloudformation deploy` → smoke test |
| `scripts/create-admin.js` | Creates the first Super Admin (no demo passwords in production) |

**The app does not run "in S3".** S3 holds the nurse documents; the app runs on ECS Fargate behind the load balancer, with RDS for data.

### One-time setup

1. **Put the code on GitHub** (a private repository), e.g. `uyirjobs/nurse-registration`.
2. **Certificate:** in ACM (region **ap-south-1**), request a public certificate for `uyirjobs.in` and validate it by DNS. Copy its ARN.
3. **Bootstrap stack** (from a machine with admin AWS credentials):
   ```bash
   aws cloudformation deploy --region ap-south-1 --stack-name uyir-bootstrap \
     --template-file infra/bootstrap.yml --capabilities CAPABILITY_NAMED_IAM \
     --parameter-overrides GitHubRepo=uyirjobs/nurse-registration
   aws cloudformation describe-stacks --region ap-south-1 --stack-name uyir-bootstrap --query "Stacks[0].Outputs" --output table
   ```
   (If the account already has the GitHub OIDC provider, add `CreateOidcProvider=false`.)
4. **GitHub settings** → *Secrets and variables → Actions → Variables*: add `AWS_DEPLOY_ROLE_ARN` and `CFN_EXECUTION_ROLE_ARN` from the outputs. → *Environments*: create `production` (add required reviewers if you want a manual approval before each deploy).
5. **Edit `infra/prod.params.json`:** `CertificateArn`, `WhatsAppBusinessNumber`, and optionally `HostedZoneId` (creates the DNS record) and `AlarmEmail`. Commit and push to `main`.

The first deploy takes about 25 minutes (mostly RDS Multi-AZ). Later deploys take 5–8 minutes, with no downtime: new tasks must pass `/healthz` before old ones stop, and a release whose tasks keep failing is rolled back automatically.

### After the first deploy

- **DNS:** if you didn't set `HostedZoneId`, point `uyirjobs.in` at the `LoadBalancerDns` output (alias/CNAME).
- **First Super Admin**: run a one-off task with the app image (values from the stack outputs):
  ```bash
  aws ecs run-task --region ap-south-1 --cluster uyir --task-definition uyir-app --launch-type FARGATE \
    --network-configuration "awsvpcConfiguration={subnets=[<TaskSubnets>],securityGroups=[<AppSecurityGroup>],assignPublicIp=<TaskAssignPublicIp>}" \
    --overrides '{"containerOverrides":[{"name":"app","command":["node","scripts/create-admin.js"],"environment":[
      {"name":"ADMIN_USERNAME","value":"superadmin"},{"name":"ADMIN_NAME","value":"State Super Admin"},{"name":"ADMIN_PASSWORD","value":"<a long password>"}]}]}'
  ```
  Then sign in at `https://uyirjobs.in` and create District Admins under **Staff accounts**. (The override is visible to anyone who can read ECS task details in the account; change the password after first sign-in.)
- **Existing data** (from your local database): `pg_dump` the local `uyir` database and restore it into RDS through a bastion or SSM port-forward, then run `npm run migrate:s3` with `STORAGE_DRIVER=s3` to move local documents into the bucket.
- **WhatsApp:** put the Meta token and app secret into the `uyir/whatsapp` secret (`token`, `app_secret`), set `"WhatsAppProvider": "meta"` and `WhatsAppPhoneNumberId` in `infra/prod.params.json`, and push. Register the `WebhookUrl` output in Meta with the generated `verify_token` from the same secret.

### Rough monthly cost (ap-south-1, light load)

RDS db.t4g.medium Multi-AZ ≈ USD 100 · 2 NAT gateways ≈ USD 70 + data · ALB ≈ USD 20 · 2 Fargate tasks (0.5 vCPU / 1 GB) ≈ USD 35 · S3, KMS, Secrets Manager, logs ≈ USD 10. **About USD 230/month.** For a cheaper pilot, set `DbMultiAz` to `false` and `DesiredCount` to `1` (no high availability).

### Not in the template yet

- CloudFront + WAF in front of the ALB (rate limits on `/api/public/*`), and the cross-region replica bucket and snapshot copies to ap-south-2. Both are described below.
- An SMS gateway for the invite (DLT registration first; see `docs/WHATSAPP.md`).

---

Region **ap-south-1 (Mumbai)**, DR copy in **ap-south-2 (Hyderabad)**, so nurse data stays in India (DPDP Act).

```
                Route 53  uyirjobs.in (nurse portal, /register)   admin.uyirjobs.in (staff)
                    │
            CloudFront + AWS WAF  (TLS via ACM, rate limits on /api/public/*, geo = IN, managed rules)
                    │
     Application Load Balancer  (public subnets, 3 AZs, health check GET /healthz)
                    │
   ┌────────────────┼────────────────┐
 ECS Fargate      ECS Fargate      ECS Fargate      ← stateless app tasks, private subnets,
 task (AZ-a)      task (AZ-b)      task (AZ-c)        min 2 / max N, CPU + request-count autoscaling
   │                 │                 │
   ├── RDS PostgreSQL Multi-AZ (or Aurora PostgreSQL)  ← sessions, nurses, events, documents rows
   ├── S3  uyirjobs-documents-prod  (via VPC gateway endpoint)  ── CRR ──▶ ap-south-2 replica
   ├── Secrets Manager (DB creds, FIELD_ENC_KEY)               KMS CMK (S3 + RDS + secrets)
   └── SQS  sms-outbox  → SMS worker (DLT gateway)            CloudWatch alarms / logs
```

## What is already done in code

| Piece | Status |
|---|---|
| Documents in S3 (`STORAGE_DRIVER=s3`) | Done: `server/src/services/storage.js` (multipart upload → file type checked from its bytes → `PutObject`). SSE-KMS, SHA-256 checksum on every put, keys with no personal data (`documents/<nurseId>/<type>/<uuid>.pdf`) |
| Staff document viewing | Done: the app checks role and district, logs the access, then redirects to a presigned URL that expires in 60 s |
| Old local files | Still readable: each row records its driver (`documents.storage`) |
| Health check for ALB | Done: `GET /healthz` (add `HEALTH_CHECK_STORAGE=1` to also probe S3) |
| Bank details encrypted at rest | Done: AES-256-GCM with `FIELD_ENC_KEY`; staff see only the last 4 digits |
| HTTPS-only config | Done: production refuses to start without an `https://` `PUBLIC_URL`, and sends HSTS |
| PostgreSQL | Done: `server/src/db/` (`pg` pool, TLS with the RDS CA bundle). Sessions, OTPs and registration state all live in Postgres, so app tasks hold no state |
| Safe with many app servers | Nurse IDs come from a sequence. Status changes lock the nurse row (`SELECT … FOR UPDATE`). Staff actions carry the status they expect to change, so two admins (or overlapping bulk invites) can't both apply: each nurse gets one invite. Duplicate mobiles map to HTTP 409 via the unique index. Covered by the concurrency test |
| Rolling deploys | Schema setup runs under a Postgres advisory lock, so tasks starting together don't race. `SIGTERM` drains in-flight requests before exit |
| Moving off SQLite | `npm run migrate:sqlite` (copies everything except sessions), then `npm run migrate:s3` for existing uploads |

## Database: RDS PostgreSQL

- **Engine:** RDS for PostgreSQL 16/17 **Multi-AZ** (a standby in another AZ, automatic failover in about 60–120 s), or Aurora PostgreSQL for faster failover (about 30 s) and read replicas. `db.t4g.medium` is plenty for 44k nurses; move to `m7g` when traffic grows.
- **Connections:** each task opens up to `PG_POOL_MAX` (default 10). With autoscaling, put **RDS Proxy** in front. It pools connections across tasks and shortens failover for clients.
- **Failover behaviour:** during a failover, in-flight queries fail with a 500, and the pool drops broken connections and reconnects to the same endpoint. Transactions roll back cleanly, so no half-applied status changes.
- **Backups:** automated backups with PITR (7–35 days), plus automated cross-region snapshot copy to ap-south-2. Turn on deletion protection. Storage is encrypted with the KMS CMK.
- **Access:** private subnets only; the security group allows 5432 from the ECS task security group only. Use an app user that owns the schema (no superuser), with credentials in Secrets Manager (rotation on). Enable the `pg_trgm` extension once as the master user for fast name search; without it the app still works, but search scans the table.
- **Optional extras:** a read replica for heavy reporting/CSV exports; Performance Insights on.

## S3 bucket configuration

- **Block Public Access** on (all four). Object Ownership = bucket owner enforced (no ACLs).
- **Default encryption** SSE-KMS with a customer-managed key, Bucket Key enabled.
- **Versioning** on. Lifecycle: noncurrent versions → Glacier Instant Retrieval after 30 days, expire after your retention period. Abort incomplete multipart uploads after 1 day.
- **Cross-Region Replication** to `uyirjobs-documents-dr` in ap-south-2 (replicates KMS-encrypted objects with a DR-region key).
- **Bucket policy**: deny `aws:SecureTransport = false`. Deny `PutObject` without `aws:kms`. Allow only the ECS task role, and optionally only via the VPC endpoint (`aws:sourceVpce`).
- **No CORS** needed: uploads go through the app (5 MB cap, magic-byte check); views are top-level navigations to presigned URLs.
- Optional: **GuardDuty Malware Protection for S3** on the bucket. Add **Object Lock (governance)** if your retention policy requires immutability.

Task-role IAM policy (least privilege; no static access keys anywhere):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": ["s3:PutObject", "s3:GetObject"],
      "Resource": "arn:aws:s3:::uyirjobs-documents-prod/documents/*" },
    { "Effect": "Allow", "Action": "s3:ListBucket", "Resource": "arn:aws:s3:::uyirjobs-documents-prod" },
    { "Effect": "Allow", "Action": ["kms:GenerateDataKey", "kms:Decrypt"],
      "Resource": "arn:aws:kms:ap-south-1:<account>:key/<s3-key-id>" }
  ]
}
```

(No `DeleteObject`: superseded documents are kept for audit; lifecycle rules handle expiry.)

## Availability targets

| Failure | Effect | Recovery |
|---|---|---|
| One app task / AZ dies | ALB stops routing to it after health checks fail | ECS replaces it automatically; no downtime with ≥2 tasks in ≥2 AZs (tasks are stateless; sessions live in Postgres) |
| RDS primary AZ fails | Writes pause about 1–2 min | Multi-AZ failover, same endpoint |
| S3 | 99.99 % availability, 11×9s durability by design | — |
| Whole region down | Outage | DR runbook: restore the latest snapshot copy in ap-south-2, point the app at the replica bucket, switch DNS. RPO ≈ minutes (CRR) to hours (snapshot cadence); RTO ≈ 1–2 h |

## Scaling notes

- Uploads currently pass through the app as base64 JSON (≤5 MB). If upload volume grows, switch to **presigned POST** with a `content-length-range` condition, written to a `quarantine/` prefix. A Lambda on `ObjectCreated` checks the magic bytes (and the malware scan result) before moving the file to `documents/` and inserting the row.
- Move SMS out of the request path: write `messages` as `queued`, push to SQS, and have a worker send through the DLT gateway with retries and a DLQ.

## Environment (production)

See `.env.example`. Keep secrets in Secrets Manager and inject them as ECS task secrets.
