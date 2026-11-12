# Step-by-step: RDS + S3 + deploy to ECS (uyirjobs.in)

This guide deploys the app to AWS **from your own Windows computer** (PowerShell). You don't need GitHub for the first deploy; you can add the automatic GitHub pipeline later (step 12).

You don't create RDS, S3 and ECS one by one by clicking in the console. The template `infra/app.yml` creates all of them together, already wired up:

| What | Created by `infra/app.yml` |
|---|---|
| **RDS** | PostgreSQL 17, Multi-AZ, encrypted, private (not reachable from the internet), 14-day backups, deletion protection. Password generated and kept in Secrets Manager (`uyir/db`). |
| **S3** | Private bucket `uyir-documents-<account>-ap-south-1` for nurse documents: KMS encryption, versioning, HTTPS only, all public access blocked. |
| **ECS** | Fargate cluster `uyir`, service `uyir-app` (2 tasks), behind a load balancer with HTTPS. Tasks may only read/write `documents/` in the bucket. |
| Also | VPC, KMS key, secrets (`uyir/db`, `uyir/field-enc-key`, `uyir/whatsapp`), logs in CloudWatch (`/ecs/uyir`). |

All commands below are run in **PowerShell**, from the project folder (`B:\rec`). Region is **ap-south-1 (Mumbai)** throughout.

---

## Step 0: Before you start

You need:

- [ ] **The domain `uyirjobs.in` active at Hostinger** (hPanel → Domains shows *Active*, verification email confirmed).
- [ ] **AWS CLI** signed in with an admin user/role for account `889951087887`.
- [ ] **Docker Desktop** running.
- [ ] A stable internet connection (the first deploy runs ~25 minutes).

Check:

```powershell
aws sts get-caller-identity
docker info --format "{{.ServerVersion}}"
```

The first should print your account number, the second a version number.

Set the region once for this PowerShell window:

```powershell
$env:AWS_REGION = "ap-south-1"; $env:AWS_DEFAULT_REGION = "ap-south-1"
```

> If you open a new PowerShell window later, run that line again.

---

## Step 1: DNS for the domain (Hostinger → Route 53)

The domain is registered at **Hostinger**. Keep it registered there (renewals stay in Hostinger), but let **Route 53** answer its DNS. That way AWS creates the certificate check record and the `uyirjobs.in` → load balancer record for you. Hostinger's own DNS can't point the bare `uyirjobs.in` at an AWS load balancer reliably, because the load balancer's IP addresses change.

**1a. Check the domain is active in Hostinger.** hPanel → **Domains** → `uyirjobs.in` must show **Active**. If it shows *Pending* / *Pending setup* / *Suspended*, finish the setup and click the link in Hostinger's verification email first. Until then the domain doesn't exist on the internet.

**1b. Create the hosted zone in Route 53.**
AWS console → **Route 53 → Hosted zones → Create hosted zone** → Domain name `uyirjobs.in`, type **Public hosted zone** → Create.
Open it and note:
- the **Hosted zone ID** (looks like `Z0123456789ABCDEF`), needed in step 3;
- the 4 values of the **NS** record, e.g. `ns-123.awsdns-15.com`, `ns-456.awsdns-57.net`, `ns-789.awsdns-34.org`, `ns-1011.awsdns-12.co.uk`.

**1c. Point Hostinger at Route 53.**
hPanel → **Domains** → `uyirjobs.in` → **DNS / Nameservers** → **Change nameservers** → choose **Change nameservers** / **Use custom nameservers** → enter the 4 Route 53 values (without a trailing dot) → **Save**.

> **Email on this domain?** After this switch, Hostinger's DNS records (including any email MX records) stop being used. If you use Hostinger email (or Google Workspace etc.) on `@uyirjobs.in`, first copy its **MX**, **TXT** (SPF/DKIM/DMARC) and any **CNAME** records from Hostinger's DNS zone into the Route 53 hosted zone, then change the nameservers.

**1d. Wait and check.** Usually 30 minutes to a few hours (up to 24–48 hours):

```powershell
nslookup -type=NS uyirjobs.in 8.8.8.8
```

It should list the four `awsdns` nameservers. Don't start step 2 until it does: the certificate check depends on it.

---

## Step 2: HTTPS certificate (ACM)

1. AWS console → switch region to **Asia Pacific (Mumbai) ap-south-1** (top right) → **Certificate Manager → Request → Request a public certificate**.
2. Domain names: `uyirjobs.in` (optionally also `www.uyirjobs.in`). Validation: **DNS validation**.
3. Open the certificate → **Create records in Route 53** → Create.
4. Wait until status is **Issued** (usually 5–30 minutes).
5. Copy the **ARN** (`arn:aws:acm:ap-south-1:889951087887:certificate/…`).

Check:

```powershell
aws acm list-certificates --query "CertificateSummaryList[].[DomainName,Status]" --output table
```

> The certificate must be in **ap-south-1**, the same region as the load balancer.

---

## Step 3: Fill in the production settings

Edit `infra/prod.params.json`:

| Setting | Put |
|---|---|
| `CertificateArn` | The ARN from step 2 |
| `HostedZoneId` | The hosted zone ID from step 1 (the `uyirjobs.in` → load balancer record is then created for you) |
| `WhatsAppBusinessNumber` | Your WhatsApp Business number, digits only, e.g. `919876543210` |
| `AlarmEmail` | Optional: an email for alerts (errors, unhealthy app, low DB storage) |
| `DbMultiAz` / `DesiredCount` | Keep `"true"` / `"2"` for production. For a cheaper pilot: `"false"` / `"1"` (about half the cost, no automatic failover). |

Leave `WhatsAppProvider` as `simulated` for now (step 11 switches it on).

No `REPLACE_ME` may remain:

```powershell
Select-String -Path infra\prod.params.json -Pattern REPLACE_ME
```

This should print nothing.

---

## Step 4: Bootstrap stack (container registry)

This creates the **ECR repository** `uyir-nurse-registration` where your app image is stored, plus the roles the GitHub pipeline will use later. Run once:

```powershell
aws cloudformation deploy --stack-name uyir-bootstrap --template-file infra/bootstrap.yml --capabilities CAPABILITY_NAMED_IAM --parameter-overrides GitHubRepo=uyirjobs/nurse-registration
```

Replace `uyirjobs/nurse-registration` with the GitHub repository you'll use later (it can be one that doesn't exist yet). If it fails with "provider already exists", add `CreateOidcProvider=false` after the `GitHubRepo=…` value and run it again.

Check:

```powershell
aws cloudformation describe-stacks --stack-name uyir-bootstrap --query "Stacks[0].Outputs" --output table
```

Keep this output; you need `RepositoryUri` next and the two role ARNs in step 12.

---

## Step 5: Build the app image and push it to ECR

```powershell
$acct  = aws sts get-caller-identity --query Account --output text
$repo  = "$acct.dkr.ecr.ap-south-1.amazonaws.com/uyir-nurse-registration"
$tag   = Get-Date -Format "yyyyMMdd-HHmm"
$image = "${repo}:$tag"

aws ecr get-login-password | docker login --username AWS --password-stdin "$acct.dkr.ecr.ap-south-1.amazonaws.com"
docker build --platform linux/amd64 -t $image .
docker push $image
$image
```

The last line prints the image name; keep this window open (`$image` is used in step 6).

> Tags can't be reused (the repository is immutable), which is why the tag is the date and time. Every new release gets a new tag.

---

## Step 6: Deploy RDS + S3 + ECS (the app stack)

```powershell
$params = (Get-Content infra\prod.params.json -Raw | ConvertFrom-Json).PSObject.Properties | ForEach-Object { "$($_.Name)=$($_.Value)" }
aws cloudformation deploy --stack-name uyir-prod --template-file infra/app.yml --capabilities CAPABILITY_IAM --parameter-overrides $params "ImageUri=$image" --tags app=uyir
```

This takes **about 25 minutes** the first time (RDS Multi-AZ is the slow part). The command waits and prints `Successfully created/updated stack` at the end.

Watch progress in the console: **CloudFormation → Stacks → uyir-prod → Events**.

If it fails, see what went wrong:

```powershell
aws cloudformation describe-stack-events --stack-name uyir-prod --max-items 30 --query "StackEvents[?contains(ResourceStatus,'FAILED')].[LogicalResourceId,ResourceStatusReason]" --output table
```

A failed **first** create rolls everything back; fix the cause, delete the stack (`aws cloudformation delete-stack --stack-name uyir-prod`, wait for it to finish) and run step 6 again. The S3 bucket, KMS key and `uyir/field-enc-key` secret are kept on delete by design; if a re-create then fails with "already exists", delete those leftovers in the console first (only if they are empty / unused).

Show the results:

```powershell
aws cloudformation describe-stacks --stack-name uyir-prod --query "Stacks[0].Outputs" --output table
```

---

## Step 7: Check RDS, S3 and ECS

**RDS**: should be `available`, Multi-AZ, encrypted, not public:

```powershell
aws rds describe-db-instances --db-instance-identifier uyir-db --query "DBInstances[0].[DBInstanceStatus,MultiAZ,StorageEncrypted,PubliclyAccessible,Endpoint.Address]" --output table
```

Expected: `available | True | True | False | uyir-db.….rds.amazonaws.com`. The app creates its tables itself on first start.

**S3**: private, encrypted, versioned:

```powershell
$bucket = aws cloudformation describe-stacks --stack-name uyir-prod --query "Stacks[0].Outputs[?OutputKey=='DocumentsBucket'].OutputValue" --output text
aws s3api get-public-access-block --bucket $bucket
aws s3api get-bucket-encryption --bucket $bucket --query "ServerSideEncryptionConfiguration.Rules[0].ApplyServerSideEncryptionByDefault"
aws s3api get-bucket-versioning --bucket $bucket
```

Expected: all four public-access settings `true`, `SSEAlgorithm: aws:kms`, `Status: Enabled`.

**ECS**: 2 tasks running, deployment finished:

```powershell
aws ecs describe-services --cluster uyir --services uyir-app --query "services[0].[status,runningCount,desiredCount,deployments[0].rolloutState]" --output table
```

Expected: `ACTIVE | 2 | 2 | COMPLETED`.

**App log**: should show `documents: s3` and `database: PostgreSQL`:

```powershell
aws logs tail /ecs/uyir --since 30m
```

**Website**:

```powershell
curl.exe -s https://uyirjobs.in/healthz
```

Expected: `{"ok":true,"storage":"s3"}`. If DNS isn't ready yet, try the load balancer directly (certificate warning is expected there): `curl.exe -sk https://<LoadBalancerDns>/healthz`.

> If you did **not** set `HostedZoneId`, point the domain at the `LoadBalancerDns` output yourself now (Route 53 alias A record, or a CNAME at your DNS provider for `www`).

---

## Step 8: Create the first Super Admin

The database starts empty, with no demo accounts. Create the first admin with a one-off task.

1. Save this as `admin-task.json` **outside the project folder** (e.g. in Downloads), with your own username and a long password (12+ characters):

```json
{
  "containerOverrides": [{
    "name": "app",
    "command": ["node", "scripts/create-admin.js"],
    "environment": [
      { "name": "ADMIN_USERNAME", "value": "superadmin" },
      { "name": "ADMIN_NAME", "value": "State Super Admin" },
      { "name": "ADMIN_PASSWORD", "value": "CHANGE-this-to-a-long-password" }
    ]
  }]
}
```

2. Run it:

```powershell
$out    = aws cloudformation describe-stacks --stack-name uyir-prod --query "Stacks[0].Outputs" --output json | ConvertFrom-Json
$subnets = ($out | Where-Object OutputKey -eq TaskSubnets).OutputValue
$pubip   = ($out | Where-Object OutputKey -eq TaskAssignPublicIp).OutputValue
$sg      = ($out | Where-Object OutputKey -eq AppSecurityGroup).OutputValue
aws ecs run-task --cluster uyir --task-definition uyir-app --launch-type FARGATE --network-configuration "awsvpcConfiguration={subnets=[$subnets],securityGroups=[$sg],assignPublicIp=$pubip}" --overrides file://$HOME/Downloads/admin-task.json --query "tasks[0].taskArn" --output text
```

3. After about a minute, check the log for `Created Super Admin "superadmin"`:

```powershell
aws logs tail /ecs/uyir --since 10m --filter-pattern Created
```

4. **Delete `admin-task.json`.** Sign in at **https://uyirjobs.in** and create the District Admins under **Staff accounts**. (The password is visible in the ECS task details to anyone with access to the AWS account, so change it after the first sign-in.)

---

## Step 9: Test that documents go to S3

> **Do step 11 (WhatsApp) first.** The nurse must verify their mobile with an OTP, which is sent on WhatsApp. In production the OTP is never shown on screen or written to the log, so while WhatsApp is `simulated` nobody can get past that screen.

1. Sign in, **Add nurse** (use your own mobile), open the nurse, copy the **Registration link** shown on the page.
2. Open the link on your phone, enter the OTP you receive on WhatsApp, fill in the form and upload a PDF.
3. Back on the nurse page, click **View** on the document; it should open.
4. Check the file is in the bucket:

```powershell
aws s3 ls "s3://$bucket/documents/" --recursive
```

Expected: `documents/UYIR-NUR-…/<TYPE>/<random>.pdf`. Opening that S3 URL directly in a browser must fail with **Access Denied**: only the app's short-lived links work.

---

## Step 10: (Optional) Bring over your existing local data

Only if your local database has **real** data. The local data from `npm run seed:demo` is synthetic; skip this step for it.

RDS is private, so you reach it through a temporary EC2 "jump" machine using Session Manager (no SSH keys, no open ports):

1. EC2 → Launch instance: Amazon Linux 2023, `t3.micro`, VPC `uyir`, subnet `uyir-private-a`, security group `uyir-prod-AppSg-…`, IAM instance profile with **AmazonSSMManagedInstanceCore**. Note its instance ID.
2. On your computer (needs the Session Manager plugin for the AWS CLI), open a tunnel from local port 5433 to RDS:
   ```powershell
   aws ssm start-session --target <instance-id> --document-name AWS-StartPortForwardingSessionToRemoteHost --parameters "host=<RDS endpoint>,portNumber=5432,localPortNumber=5433"
   ```
3. In a second window, get the DB password (Secrets Manager → `uyir/db`), then copy the data:
   ```powershell
   pg_dump --no-owner --no-acl -Fc -d postgres://postgres@localhost:5432/uyir -f uyir.dump
   pg_restore --no-owner --no-acl -d "postgres://uyir_admin:<password>@localhost:5433/uyir?sslmode=require" uyir.dump
   ```
4. Move the uploaded documents into S3 (uses your AWS credentials and the tunnel):
   ```powershell
   $env:DATABASE_URL = "postgres://uyir_admin:<password>@localhost:5433/uyir?sslmode=require"
   $env:STORAGE_DRIVER = "s3"; $env:S3_BUCKET = $bucket
   npm run migrate:s3 -- --dry-run
   npm run migrate:s3
   ```
5. **Terminate the EC2 instance** and delete `uyir.dump`.

---

## Step 11: Turn on WhatsApp

1. Secrets Manager → `uyir/whatsapp` → Retrieve → Edit: set `token` and `app_secret` from your Meta app. Note the generated `verify_token`.
2. In `infra/prod.params.json` set `"WhatsAppProvider": "meta"` and `"WhatsAppPhoneNumberId": "<from WhatsApp Manager>"`.
3. Redeploy (step 13).
4. In the Meta app (WhatsApp → Configuration) register the webhook URL `https://uyirjobs.in/api/whatsapp/webhook` with that `verify_token`. Details: `docs/WHATSAPP.md`.

---

## Step 12: (Later) Automatic deploys from GitHub

Once the code is on GitHub, every push to `main` can test and deploy automatically (`.github/workflows/deploy.yml`):

1. Push this project to the GitHub repository you named in step 4 (private).
2. GitHub → Settings → Secrets and variables → Actions → **Variables**: add `AWS_DEPLOY_ROLE_ARN` = `GitHubDeployRoleArn` and `CFN_EXECUTION_ROLE_ARN` = `CloudFormationExecutionRoleArn` (from the step 4 output).
3. GitHub → Settings → **Environments** → New environment `production` (add yourself as required reviewer if you want to approve each deploy).

From then on, use git push instead of step 13.

---

## Step 13: Deploying a new version (manually)

After changing code:

```powershell
$acct  = aws sts get-caller-identity --query Account --output text
$image = "$acct.dkr.ecr.ap-south-1.amazonaws.com/uyir-nurse-registration:" + (Get-Date -Format "yyyyMMdd-HHmm")
aws ecr get-login-password | docker login --username AWS --password-stdin "$acct.dkr.ecr.ap-south-1.amazonaws.com"
docker build --platform linux/amd64 -t $image . ; docker push $image
$params = (Get-Content infra\prod.params.json -Raw | ConvertFrom-Json).PSObject.Properties | ForEach-Object { "$($_.Name)=$($_.Value)" }
aws cloudformation deploy --stack-name uyir-prod --template-file infra/app.yml --capabilities CAPABILITY_IAM --no-fail-on-empty-changeset --parameter-overrides $params "ImageUri=$image" --tags app=uyir
```

5–8 minutes, no downtime: new tasks must pass the health check before old ones stop, and a release that keeps failing is rolled back automatically. Run `npm test` before deploying.

---

## Troubleshooting

| Symptom | Look at |
|---|---|
| Stack stuck or failed | CloudFormation → uyir-prod → Events (first red `FAILED` line is the cause) |
| `CertificateArn` error | Certificate not **Issued** yet, or not in ap-south-1 |
| ECS tasks keep stopping | `aws logs tail /ecs/uyir --since 30m`; ECS → uyir → uyir-app → Tasks → Stopped → "Stopped reason" |
| `CannotPullContainerError` | Image tag wrong / not pushed (step 5) |
| Site doesn't open, health check fine on the load balancer | DNS: `nslookup uyirjobs.in 8.8.8.8` must return addresses; check the Hostinger nameservers are the 4 Route 53 ones (step 1c) |
| Certificate stuck on *Pending validation* | Nameservers not switched to Route 53 yet (step 1d), or the validation CNAME wasn't created in Route 53 (step 2.3) |
| Email on `@uyirjobs.in` stopped working | MX/TXT records weren't copied from Hostinger to Route 53 before the nameserver switch (step 1c note) |
| Document upload fails | Log line with `S3`/`AccessDenied`; the task role may only write under `documents/`, and `S3_PREFIX` must stay `documents/` |
| Can't sign in at all | Step 8 not done (production has no demo accounts) |

## Cost and safety notes

- About **USD 230/month** as configured (RDS Multi-AZ ≈ 100, 2 NAT gateways ≈ 70, load balancer ≈ 20, 2 tasks ≈ 35, rest ≈ 10). Pilot settings in step 3 roughly halve it.
- **Nothing is lost by accident:** the RDS instance has deletion protection and a final snapshot; the S3 bucket, KMS key and bank-detail key secret are kept even if the stack is deleted.
- **Never delete or rotate `uyir/field-enc-key`**: stored bank account numbers can't be read without it.
- More background (high-availability design, disaster recovery, WAF): `docs/DEPLOYMENT-AWS.md`.
