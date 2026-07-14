# 0003 — Network Foundation (terraform/app VPC)

> Create the `terraform/app/` config (its own state) with a VPC + 2 public subnets + internet gateway + route tables — the network every future workload runs in — and retarget the CI/CD pipeline from `terraform/` to `terraform/app/`. All resources are free (~$0); this is the first time the pipeline applies `terraform/app/`.

## 1. Status & metadata

- **Status:** Approved
- **Date:** 2026-07-14
- **Author:** Harmon Tuazon
- **Approved:** 2026-07-14 (user)

> Decisions settled via `/grill-me`. Execution starts only after this PRD is marked **Approved**.

## 2. User story

As the developer, I want a reproducible VPC with public subnets across two Availability Zones, provisioned by the pipeline into a dedicated `terraform/app/` config, so that the upcoming ECS services and ALB have a resilient network to run in — and so the pipeline proves it can deploy real (billable-config) infrastructure end-to-end.

## 3. Scope

**In scope:**
- **New `terraform/app/` config** (per [ADR 0002](../../architecture/decisions/0002-terraform-configuration-topology.md)): `versions.tf`, `provider.tf` (region + default tags), `backend.tf` (S3 backend, **key `app/terraform.tfstate`**, same bucket, `use_lockfile`, `encrypt`), `main.tf` (wires modules), `variables.tf`, `outputs.tf`, `.gitignore`.
- **`terraform/app/modules/network/`** — a single-purpose network module creating:
  - `aws_vpc` — CIDR `10.0.0.0/16`, DNS support + hostnames enabled.
  - **2 public subnets** — `10.0.0.0/24`, `10.0.1.0/24`, one per AZ (AZs selected dynamically via `data.aws_availability_zones`, first 2), `map_public_ip_on_launch = true`.
  - `aws_internet_gateway` attached to the VPC.
  - One public `aws_route_table` with `0.0.0.0/0 → IGW`, associated with both subnets.
- **Outputs** (root): `vpc_id`, `public_subnet_ids`, `vpc_cidr`.
- **Pipeline retarget:** `ci.yml` and `cd.yml` switch their Terraform working directory from `terraform/` to `terraform/app/` (the repo-wide `terraform fmt -check` stays repo-wide). The identity foundation in `terraform/` root becomes fully human-applied.

**Out of scope (later PRDs):**
- Security groups (created with the resources they protect — ALB, ECS — in the next PRD).
- The ECS cluster, ALB, ECR, DynamoDB, SQS/SNS, Lambda — the ECS/ALB PRD onward.
- Private subnets / NAT gateway / VPC endpoints (deliberately none — public-subnet, no-NAT design per ADR 0001).
- Any change to the deployer/ci-plan IAM (it already has EC2/VPC + S3-state access from PRD 0001).

## 4. Success criteria

1. `terraform validate` passes in `terraform/app/`; `plan` shows the VPC + 2 subnets + IGW + route table + associations to **add, 0 to change, 0 to destroy**.
2. The PR's CI (`ci.yml`) plans **`terraform/app/`** as `soa-ci-plan` and passes (`fmt`/`validate`/`plan -lock=false`).
3. Merging triggers CD (`cd.yml`), which `terraform apply`s **`terraform/app/`** as `soa-deployer` and creates the network — proving the pipeline deploys real infra.
4. `terraform output` (in `terraform/app/`) returns a real `vpc_id` and two `public_subnet_ids`; confirm in AWS (`aws ec2 describe-vpcs` / `describe-subnets`).
5. The pipeline now operates on `terraform/app/` (workflows retargeted); a subsequent no-op run shows 0 changes.
6. Cost impact is **$0** — no NAT, no ALB, no compute (`infra-reviewer` confirms).

## 5. Resources

| Resource | Terraform type | Cost |
| --- | --- | --- |
| VPC | `aws_vpc` | Free |
| Public subnets ×2 | `aws_subnet` | Free |
| Internet gateway | `aws_internet_gateway` | Free |
| Route table + 2 associations | `aws_route_table`, `aws_route`, `aws_route_table_association` | Free |
| New state object | S3 key `app/terraform.tfstate` in existing bucket | ~$0 |

**Total cost impact: $0.** All networking primitives are free; the only billable networking resource (NAT gateway) is deliberately absent.

External references: Terraform AWS provider (`aws_vpc`, `aws_subnet`, `aws_internet_gateway`, `aws_route_table`, `data.aws_availability_zones`).

## 6. Scripts / commands

Executed via the PR → CI → merge → CD flow (the pipeline does the apply, per the grill decision). Branch protection requires a PR.

```bash
# 1. Validate locally (read-only; optional — CI also does this)
terraform -chdir=terraform/app init -backend-config=backend.hcl
terraform -chdir=terraform/app validate
terraform -chdir=terraform/app plan          # preview: VPC + subnets + IGW + routes to add

# 2. Open a PR with terraform/app/ + retargeted workflows
git checkout -b add-network
git add terraform/app .github/workflows/
git commit -m "Add VPC network foundation (terraform/app) and retarget pipeline"
git push -u origin add-network
# open PR -> CI plans terraform/app -> review -> merge

# 3. Merge -> cd.yml applies terraform/app  (⚠️ creates the VPC, as soa-deployer)

# 4. Verify
aws ec2 describe-vpcs  --filters "Name=tag:Project,Values=soa" --query 'Vpcs[].VpcId'
aws ec2 describe-subnets --filters "Name=tag:Project,Values=soa" --query 'Subnets[].SubnetId'
```

## 7. Planned agents

- **`terraform-engineer`** — writes the `terraform/app/` config + `modules/network/`; `fmt`/`validate`/`plan` (plan-only). Hands off validated code.
- **`pipeline-engineer`** — retargets `ci.yml`/`cd.yml` to `terraform/app/` (working directory + init path), keeping the repo-wide `fmt` check and OIDC role split intact.
- **`infra-reviewer`** — audits the network module (public-subnet/no-NAT correctness, no billable resources, no over-broad routes/SGs) and the workflow retarget (still keyless, CI plan-only on `terraform/app/`, CD apply on `main`).
- **Main session** — orchestrates; drives the PR/merge (the pipeline performs the apply).
- **`documentation-keeper`** — after execution, updates `docs/operations/` (pipeline now targets `terraform/app/`; the VPC) and the architecture overview; fills nothing in the PRD Outcome (main session owns it).

## 8. Testing / verification plan

| Success criterion | Verification |
| --- | --- |
| #1 plan clean | `terraform -chdir=terraform/app plan` — network resources to add, 0 destroy (terraform-engineer + CI) |
| #2 CI green | PR's `ci.yml` run: OIDC as `soa-ci-plan`, `plan` on `terraform/app/` passes |
| #3 CD applies | merge → `cd.yml` run: OIDC as `soa-deployer`, `apply` on `terraform/app/` creates the VPC |
| #4 outputs real | `terraform -chdir=terraform/app output`; `aws ec2 describe-vpcs/describe-subnets` |
| #5 retargeted | workflows reference `terraform/app/`; a follow-up run shows 0 changes |
| #6 $0 cost | `infra-reviewer`: no NAT/ALB/compute/EIP; plan resource list is free-tier only |

## 9. Additional considerations

- **Security posture:** public subnets with `map_public_ip_on_launch` is the deliberate no-NAT cost trade — it means future workloads are internet-adjacent, so the **security groups in the next PRD must be tight** (only the ALB open to the internet; tasks reachable only from the ALB). No datastores exist yet.
- **This confirms ADR 0002 in practice:** the pipeline now applies `terraform/app/`; the identity foundation (`terraform/`) is no longer pipeline-applied. `terraform/app/` is the config that gets `terraform destroy`ed between sessions (still $0 today).
- **Deployer permission risk:** if the deployer is missing an EC2 action for VPC creation, CD will fail on that resource. Fix is a **human `terraform apply`** of the deployer policy (same pattern as PRD 0002's `ListRolePolicies` fix) — the pipeline can't grant itself IAM.
- **Rollback/teardown:** `terraform -chdir=terraform/app destroy` removes the whole network cleanly (all free). Nothing here bills, so teardown is optional until ECS/ALB land.
- **Open item:** a free S3/DynamoDB **gateway VPC endpoint** could later reduce data-transfer cost once workloads talk to those services — noted for the data/ECS PRD, not needed now.

---

## Outcome

_Filled after execution._
