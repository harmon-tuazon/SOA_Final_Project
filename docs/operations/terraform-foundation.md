# Terraform Foundation: State Backend & Keyless Deploy Auth

How to stand up (and work with) the remote state backend and GitHub OIDC deployer role built by [PRD platform/0001](../action_plan/platform/0001-terraform-foundation.md). Decision context: [ADR 0001](../architecture/decisions/0001-platform-and-compute-architecture.md).

## 1. Local prerequisites

- **AWS CLI**, configured with credentials for the account this project deploys into:
  ```
  aws configure
  ```
  Use an IAM user access key with sufficient privileges to run the commands below (bootstrap + root apply need `s3:*` on the state bucket and `iam:*` for the OIDC provider/deployer role — an admin or equivalent identity is simplest for this one-time setup). This is a **human/local** credential, distinct from the pipeline's keyless auth described in §4 — it is only used to stand up the foundation, not by CI/CD.
  - **Eventual-consistency gotcha:** if you just created the IAM user or attached its policy, the very next AWS CLI/Terraform call can fail with a transient `AccessDenied` before IAM propagates the change account-wide. Wait a few seconds and retry — this is not a real permissions problem.
- **Terraform >= 1.10**, verify with:
  ```
  terraform version
  ```
  This version floor is required for native S3 state locking (`use_lockfile`) — see [`terraform/versions.tf`](../../terraform/versions.tf). Earlier versions cannot use this backend as configured.

## 2. The bootstrap-once pattern

Terraform's S3 backend cannot create its own bucket — something has to create it before `terraform init` can point at it. That something is [`terraform/bootstrap/`](../../terraform/bootstrap/): a separate, minimal config with its own **local** state (a `terraform.tfstate` file on disk, gitignored — see [`terraform/bootstrap/.gitignore`](../../terraform/bootstrap/.gitignore)). It manages exactly one resource: the versioned, encrypted, public-access-blocked S3 bucket (`soa-tfstate-<account_id>`) that the root config then uses as its remote backend.

This config is run **once, by hand**, and is intentionally kept outside the project's normal lifecycle:

- It is **not** part of the root config's `terraform destroy` cycle — destroying the root config never touches this bucket.
- It is **not** re-applied routinely — there is nothing to change day-to-day.
- The bucket is deliberately hard to destroy by accident: `force_destroy = false` means AWS refuses to delete it while it holds objects (and versioning keeps it non-empty in practice), so a careless `terraform destroy` against the bootstrap config errors out instead of silently wiping remote state. See [`terraform/bootstrap/main.tf`](../../terraform/bootstrap/main.tf) for the resource definitions and the reasoning inline.

If the bucket is ever deleted deliberately (e.g. final teardown after grading), see §7.

## 3. Init / plan / apply the root config

The root config ([`terraform/`](../../terraform/)) reads/writes its state in the bucket bootstrap created, and manages the GitHub OIDC provider + deployer IAM role + permissions boundary.

```bash
# One-time bootstrap (see §2) — only needed if the state bucket doesn't exist yet
cd terraform/bootstrap
terraform init
terraform plan
terraform apply

# Root config
cd ../
cp backend.hcl.example backend.hcl   # first time only — then edit backend.hcl
terraform init -backend-config=backend.hcl
terraform fmt -check && terraform validate
terraform plan
terraform apply
```

**Why `-backend-config=backend.hcl`:** a Terraform backend block cannot use variables or interpolation, so the state bucket's name has to be a literal string at `terraform init` time. That name embeds the AWS account id (`soa-tfstate-<account_id>`), and account ids should not sit in a committed file. [`terraform/backend.tf`](../../terraform/backend.tf) declares every other backend setting (key, region, encryption, native locking) but deliberately omits `bucket`; the bucket name is supplied separately via a `-backend-config` file. [`terraform/backend.hcl.example`](../../terraform/backend.hcl.example) is the committed template — copy it to `backend.hcl` (gitignored, per [`terraform/.gitignore`](../../terraform/.gitignore)) and fill in the real bucket name, which must match what bootstrap created (`terraform output state_bucket_name` in `terraform/bootstrap/` will print it).

State locking is **native S3 locking** (`use_lockfile = true`) — no DynamoDB lock table. This is only available on Terraform >= 1.10, which is why that version floor matters (§1).

## 4. The keyless-auth model

The pipeline (documented fully once the CI/CD PRD lands) never holds long-lived AWS credentials. Instead:

1. **GitHub OIDC provider** (`aws_iam_openid_connect_provider.github_actions` in [`terraform/iam.tf`](../../terraform/iam.tf)) tells AWS to trust short-lived identity tokens issued by GitHub Actions for this account.
2. **`soa-deployer` IAM role**'s trust policy only accepts a token whose `sub` claim matches `repo:harmon-tuazon/SOA_Final_Project:ref:refs/heads/main` — so only a workflow run on this repo's `main` branch can assume it. Any other branch, fork, or pull-request run is rejected at the trust-policy level, before any permissions are even evaluated.
3. A workflow run assumes the role via `sts:AssumeRoleWithWebIdentity` for the duration of that run only — no keys are ever stored in GitHub.

**The `soa-boundary` permissions-boundary pattern:** `soa-deployer`'s own policy (`soa-deployer-permissions`) is scoped to the AWS services this project's architecture uses (ECS, ECR, EC2/VPC networking, ELB, DynamoDB, SQS, SNS, CloudWatch, Application Auto Scaling, Cognito, and scoped IAM to manage project roles/policies) — see [`terraform/iam.tf`](../../terraform/iam.tf) for the exact statements. On its own, a role allowed to `iam:CreateRole` could mint a new `soa-*` role, attach an admin-equivalent policy to it, and pass it to an ECS task or Lambda — a self-escalation path. `soa-boundary` closes that: it is the **effective-permission ceiling** every workload role (ECS task roles, task execution roles, Lambda execution roles) is bound by, and `soa-deployer` may only `iam:CreateRole` when that boundary is attached — no matter what identity policy later gets attached to the role, its real permissions can never exceed the boundary. The boundary itself is narrow (data-plane actions only: DynamoDB item access, SQS send/receive, SNS publish, S3 object access, SSM parameter read, log writes, ECR pull, Cognito auth, X-Ray) and carries no `iam:*` or `sts:AssumeRole*` actions, so a role bound by it cannot re-escalate itself.

## 5. Operational rule: the deployer cannot touch its own IAM

`soa-deployer`'s policy carries explicit **Deny** statements (`DenyDeployerPolicySelfEdit`, `DenyDeployerRoleSelfEdit` in [`terraform/iam.tf`](../../terraform/iam.tf)) blocking it from versioning/deleting its own policy or attaching/detaching policies, editing its own trust, or passing itself anywhere. IAM evaluates an explicit Deny ahead of any Allow, so this holds even though the role's Allow statements would otherwise match its own ARN (it fits the `soa-*` glob it manages).

**Consequence:** if `soa-deployer`'s role or policy ever needs to change — widening the boundary, adding a new AWS service, adjusting the trust condition — that change **cannot** be applied by the pipeline. It requires a human running `terraform apply` locally with the admin-level credentials from §1, following the same `terraform plan` review as any other apply. Treat any PR that touches `terraform/iam.tf`'s deployer role/policy accordingly.

## 6. Outputs

After a successful root apply, read the two outputs:

```bash
terraform output deployer_role_arn
terraform output oidc_provider_arn
```

Defined in [`terraform/outputs.tf`](../../terraform/outputs.tf). These are not secrets (an IAM role ARN grants nothing by itself — the OIDC trust policy is what restricts who can assume it), but they are also not stable/predictable strings, so don't hardcode them. When the CI/CD pipeline PRD is executed, these two values become GitHub Actions **variables** (not secrets) that the workflow reads to assume the role and tag runs — never committed to the repo.

## 7. Teardown

The root config is a normal part of the `terraform destroy` cycle: `terraform destroy` in `terraform/` removes the OIDC provider, `soa-deployer` role, `soa-boundary` policy, and `soa-deployer-permissions` policy, returning that spend to $0 (it was already ~$0 — no billable resources here).

The **state bucket is deliberately excluded** from this cycle (see §2). It only goes away as a final, manual step (e.g. after grading is complete):

```bash
cd terraform/bootstrap
# empty the bucket first (versioned objects included), or set force_destroy = true
terraform destroy
```

Do this last, after every other Terraform config in the project has been destroyed — deleting the state bucket while other state still lives in it orphans that state.
