# product

ECS Fargate microservice serving an Amazon-style product-catalog REST API,
backed by its own DynamoDB table. Built to
[`docs/action_plan/product/0001-service-scaffold.md`](../../docs/action_plan/product/0001-service-scaffold.md)
and the [service contract](../../.claude/rules/service-contract.md).

## What it does

Lets a shopper browse a product catalog — list/search/filter products by
category and keyword, view a single product's detail — and lets a caller
create, edit, delete, and adjust the stock of a product. There is no
service-to-service call to the order service; the order service keeps its
own denormalized line-item snapshot at purchase time (see
`order/0002` follow-up).

The server is authoritative for `id`, `createdAt`, and `updatedAt`. Any
client-supplied value for those fields is ignored, never trusted. `stock`
is never touched by `POST`/`PATCH /products/:id` — it only ever changes
through the atomic `PATCH /products/:id/stock` route.

## Routes

| Method | Path | Behaviour |
| --- | --- | --- |
| `GET` | `/health` | `200 OK`, plain text. Fast, DB-free — the ALB target-group health check. |
| `GET` | `/products` | List products, newest `createdAt` first. Optional `?category=` (exact match) and `?q=` (case-insensitive substring on `name` + `description`), combinable. |
| `GET` | `/products/:id` | A single product; `404` if unknown. |
| `POST` | `/products` | Create a product. `400` with `{error}` naming the offending field on an invalid body; `201` + the created product otherwise. |
| `PATCH` | `/products/:id` | Partial update of `name`/`description`/`price`/`category`/`imageUrl`/`rating` only — ignores client-sent `id`/`createdAt`/`stock`. `200` + updated product; `400` on an invalid or empty patch; `404` unknown. |
| `PATCH` | `/products/:id/stock` | Adjust stock by `{ "delta": <integer> }`, atomically. `200` with the new stock; `400` on a missing/non-integer `delta`; `404` unknown; `409` if the delta would take stock below zero. |
| `DELETE` | `/products/:id` | Remove a product. `204` on success; `404` if unknown. |
| `OPTIONS` | `/products*` | CORS preflight → `204`. |

### Create request body

```json
{
  "name": "Widget",
  "description": "A fine widget",
  "price": 9.99,
  "category": "Tools",
  "imageUrl": "https://example.com/widget.png",
  "stock": 5,
  "rating": 4.5
}
```

Validation: `name` non-empty string, 1–200 chars; `description` optional,
≤2000 chars; `price` a finite number ≥ 0 (stored rounded to 2dp);
`category` non-empty string, 1–60 chars; `imageUrl` optional, must start
with `http://` or `https://`; `stock` optional integer ≥ 0 (defaults to
`0`); `rating` optional number between 0 and 5 (defaults to `0`).

### Stock adjustment

`PATCH /products/:id/stock` takes a single atomic conditional
`UpdateCommand` (`ADD stock :delta`, guarded by a `ConditionExpression`
that the result stays ≥ 0) — never a read-then-write — so two concurrent
decrements cannot both succeed past zero. The same
`ConditionalCheckFailedException` can mean either "no such product" or
"this delta would oversell"; the route makes a follow-up `GetCommand`
**only on that failure path** (never on the hot/write path) to tell the
two apart and return `404` vs `409` correctly.

## Configuration (env vars)

All config is read from the environment — nothing is hardcoded.

| Var | Required | Default | Purpose |
| --- | --- | --- | --- |
| `PRODUCT_TABLE` | yes (in AWS) | — | DynamoDB table name, injected by `app-edge`. |
| `PORT` | no | `3000` | HTTP listen port. |
| `CORS_ALLOWED_ORIGIN` | no | `*` | Value of `Access-Control-Allow-Origin` for the S3-hosted SPA's origin. Set explicitly once the SPA's origin is known; `*` is permissive and intended for local dev only. |
| `DYNAMODB_ENDPOINT` | no (local only) | unset (real DynamoDB) | Overrides the DynamoDB endpoint for local dev against DynamoDB Local. Never set in AWS. |
| `AWS_REGION` | no | `us-east-1` | Only consulted when `DYNAMODB_ENDPOINT` is set; in AWS the SDK/task role supplies region + credentials. |

## Running locally

```bash
docker compose up -d dynamodb-local

# one-time: create the local table (DynamoDB Local does not auto-create it)
aws dynamodb create-table \
  --table-name soa-product \
  --attribute-definitions AttributeName=id,AttributeType=S \
  --key-schema AttributeName=id,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --endpoint-url http://localhost:8000 \
  --region us-east-1

docker compose up --build product
curl -s localhost:3001/health
```

Or run outside Docker: `npm install && DYNAMODB_ENDPOINT=http://localhost:8000 PRODUCT_TABLE=soa-product npm start`.

Note: `order` already binds host port `3000` in `docker-compose.yml`, so
`product` maps host `3001` → container `3000` — both run locally at once.

## Tests

```bash
npm install
npm test
```

Unit tests (`tests/products.test.js`) cover validation, price rounding, and
the create/patch record builders with no HTTP or AWS dependency. Route
tests (`tests/routes.test.js`) mock `@aws-sdk/lib-dynamodb`, so `npm test`
needs **no** live DynamoDB Local and **no** AWS credentials — safe to run
in CI.

## Known limitations (deliberate, documented)

- **`GET /products?category=`/`?q=` is a `Scan`, not a `Query`.** The
  shared `data` Terraform module provisions a hash-key-only table (`id`);
  there is no GSI on `category`. `category` is pushed down as a
  `FilterExpression`; `q` needs case-insensitive substring matching, which
  DynamoDB's `FilterExpression` cannot express, so it is applied in-app
  after the `Scan` returns. This is correct and free at course-demo scale
  (tens of products) but does not scale — a GSI is a platform change,
  tracked as a follow-up PRD, not smuggled in here.
- **The API is unauthenticated.** `POST`/`PATCH`/`DELETE` have no identity
  check — any caller who can reach the ALB can create, edit, or delete any
  product, including deleting the whole catalog. This is the same
  deferred-auth posture as [ADR 0004](../../docs/architecture/decisions/0004-frontend-hosting.md)
  (Cognito needs HTTPS, which needs CloudFront), accepted knowingly for
  this course-demo scope. **Do not put real data in this service.** The
  fix lands with the HTTPS/Cognito PRD.
