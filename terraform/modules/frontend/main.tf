# frontend module: an S3 static-website bucket for the React SPA (PRD
# frontend/0001). This bucket holds ONLY the public compiled SPA bundle
# (HTML/JS/CSS) and a non-secret runtime config.json (the current ALB DNS
# name) — NEVER secrets or credentials. It lives in app-base (permanent,
# always-on, ~$0) rather than app-edge, so the SPA survives the routine
# `terraform destroy` of the edge/compute layer between sessions; only the
# backend API calls fail (gracefully) while the edge is down.
#
# Static-website hosting requires public-read of objects, which is a
# deliberate, scoped exception to this project's private-by-default data
# posture (see CLAUDE.md / ADR 0001) — accepted because nothing sensitive
# ever lands in this bucket. HTTPS/CloudFront/custom domain are deferred to
# a later PRD (today the backend API is HTTP-only, so an HTTPS SPA would hit
# mixed-content errors calling it).

resource "aws_s3_bucket" "frontend" {
  bucket = "${var.name_prefix}-frontend-${var.account_id}"

  tags = {
    Name = "${var.name_prefix}-frontend-${var.account_id}"
  }
}

# Disables ACLs in favor of bucket-policy-only access control
# (BucketOwnerEnforced) — the modern, recommended S3 setting. Public read is
# granted entirely through the bucket policy below, not through object/bucket
# ACLs.
resource "aws_s3_bucket_ownership_controls" "frontend" {
  bucket = aws_s3_bucket.frontend.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

# index.html for BOTH the index and error document: this is what lets
# client-side React Router routes survive a hard refresh or a deep link — an
# S3 website endpoint has no server-side router, so any unmatched path (e.g.
# "/orders/123") is served the SPA shell itself and React Router takes over
# from there, instead of a raw S3 404.
resource "aws_s3_bucket_website_configuration" "frontend" {
  bucket = aws_s3_bucket.frontend.id

  index_document {
    suffix = "index.html"
  }

  error_document {
    key = "index.html"
  }
}

# This bucket is deliberately public-read for website hosting — all four
# flags disabled so the bucket policy below can actually grant public
# access. Scoped to GetObject only (no list, no write) in that policy.
resource "aws_s3_bucket_public_access_block" "frontend" {
  bucket = aws_s3_bucket.frontend.id

  block_public_acls       = false
  block_public_policy     = false
  ignore_public_acls      = false
  restrict_public_buckets = false
}

data "aws_iam_policy_document" "frontend_public_read" {
  statement {
    sid       = "PublicReadGetObject"
    effect    = "Allow"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.frontend.arn}/*"]

    principals {
      type        = "AWS"
      identifiers = ["*"]
    }
  }
}

# Public read of OBJECTS only (s3:GetObject on "/*") — no s3:ListBucket, no
# write. Depends on the public_access_block so apply ordering is correct: a
# bucket policy granting public access fails if the public-access-block is
# still enabled when it's applied.
resource "aws_s3_bucket_policy" "frontend" {
  bucket = aws_s3_bucket.frontend.id
  policy = data.aws_iam_policy_document.frontend_public_read.json

  depends_on = [aws_s3_bucket_public_access_block.frontend]
}
