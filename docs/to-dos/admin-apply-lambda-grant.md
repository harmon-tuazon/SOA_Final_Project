# Admin-apply the deployer `lambda:*` grant

- **Status:** Done (2026-07-28)
- **Owner:** AWS admin — whoever holds the admin console user from [PRD platform/0007](../action_plan/platform/0007-dynamodb-console-users.md). Console access is sufficient (steps below use CloudShell); no local AWS credentials are needed.
- **When:** **BEFORE** merging the `platform/0008` messaging PR. If 0008 merges first, CD fails closed with `AccessDenied` at `lambda:CreateFunction` — nothing breaks, but the deploy stalls until this is done and CD is re-run.
- **Source:** [PRD platform/0008 §9.1](../action_plan/platform/0008-messaging-factory.md) — the only root-identity change in the current effort.
- **Verification:** the next CD run on `main` creates `soa-notification-worker` without an IAM error (check the *Infrastructure CD* run in GitHub Actions).

> **Done (2026-07-28):** the admin applied the grant locally. **Deviation:** the deployer's permissions policy was already near IAM's 6144-char limit, so rather than add a separate `LambdaManagement` statement the wildcard service statements were consolidated into one `GlobalServiceManagement` (identical permissions, verified by `infra-reviewer`) and `lambda:*` added there. CD then created `soa-notification-worker` cleanly. (This tracker mark was lost with an unmerged branch and re-applied on 2026-07-28.)

## Why this can't be automated

`soa-deployer` (the pipeline's role) deliberately cannot modify its own IAM — the identity foundation in `terraform/` root is human-applied by design ([ADR 0002](../architecture/decisions/0002-terraform-configuration-topology.md)). The 0008 PR adds a `LambdaManagement` statement to [`terraform/iam.tf`](../../terraform/iam.tf); a human with admin credentials must apply it.

## Steps (AWS CloudShell — console-only)

1. Sign in to the AWS console **as the admin console user** (the least-privilege DynamoDB users from platform/0007 cannot do this) and open **CloudShell** (terminal icon in the top bar). CloudShell runs with your console user's credentials — nothing to configure.
2. Install Terraform in CloudShell (it isn't preinstalled; this installs to your home dir and survives the session):
   ```bash
   TF_VER=1.10.5
   curl -sLo tf.zip "https://releases.hashicorp.com/terraform/${TF_VER}/terraform_${TF_VER}_linux_amd64.zip"
   unzip -o tf.zip -d ~/bin && rm tf.zip && terraform -version
   ```
3. Clone the repo **at the merge commit of the PR that changed `terraform/iam.tf`** (or `main` once that PR is merged):
   ```bash
   git clone https://github.com/harmon-tuazon/SOA_Final_Project.git && cd SOA_Final_Project/terraform
   ```
4. Init against the state bucket (the same bucket name used everywhere; see `backend.hcl.example` — the value is the repo's `TF_STATE_BUCKET` Actions variable):
   ```bash
   terraform init -backend-config="bucket=<the tfstate bucket name>"
   ```
5. Plan and **read the plan before applying**. It must show **exactly one change**: the deployer permissions policy gaining the `LambdaManagement` statement. Any other change — STOP and raise it, do not apply.
   ```bash
   terraform plan
   ```
6. Apply, then clean up:
   ```bash
   terraform apply
   ```
7. Mark this to-do **Done** (date it), move its line to the Done section of [README.md](README.md), and — if CD already failed on `AccessDenied` — re-run the failed *Infrastructure CD* workflow from the GitHub Actions UI (**Re-run failed jobs**).
