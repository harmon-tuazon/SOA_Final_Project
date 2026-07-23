# order

ECS Fargate microservice serving an Amazon-style order-history / order-detail
REST API, backed by its own DynamoDB table. Built to
[`docs/action_plan/order/0001-service-scaffold.md`](../../docs/action_plan/order/0001-service-scaffold.md)
and the [service contract](../../.claude/rules/service-contract.md).

## What it does

Lets a shopper place an order, list their order history, view a single
order's detail, and progress an order through its lifecycle
(`PLACED` → `SHIPPED` → `DELIVERED`, or `PLACED` → `CANCELLED`). Each order
stores a denormalized snapshot of its line items (`productId`, `name`,
`unitPrice`, `qty` as of purchase time) — there is no live call to a product
service.

The server is authoritative for `id`, `total`, `status`, `placedAt`,
`deliveryEstimate`, and `updatedAt`. Any client-supplied value for those
fields on `POST /orders` is ignored, never trusted.

## Routes

| Method | Path | Behaviour |
| --- | --- | --- |
| `GET` | `/health` | `200 OK`, plain text. Fast, DB-free — the ALB target-group health check. |
| `GET` | `/orders` | List orders, newest `placedAt` first. Optional `?customerId=` filter. |
| `GET` | `/orders/:id` | A single order; `404` if unknown. |
| `POST` | `/orders` | Create an order. `400` with `{error}` naming the offending field on an invalid body; `201` + the created order otherwise. |
| `PATCH` | `/orders/:id/status` | Body `{status}`. Legal transitions only: `PLACED→SHIPPED`, `SHIPPED→DELIVERED`. `200` on success; `409` on an illegal transition (including out of `CANCELLED`/`DELIVERED`); `404` unknown; `400` if `status` is missing/unknown. |
| `POST` | `/orders/:id/cancel` | Cancel — allowed only from `PLACED`. `200` on success; `409` otherwise; `404` unknown. |
| `OPTIONS` | `/orders*` | CORS preflight → `204`. |

### Create request body

```json
{
  "customerId": "cust-123",
  "items": [
    { "productId": "p1", "name": "Widget", "unitPrice": 9.99, "qty": 2 }
  ],
  "shippingAddress": {
    "line1": "123 Main St",
    "city": "Toronto",
    "postalCode": "M5V 2T6",
    "country": "CA"
  }
}
```

Validation: `customerId` non-empty string; `items` a non-empty array where
each item has a non-empty `productId` and `name`, a finite `unitPrice >= 0`,
and an integer `qty >= 1`; `shippingAddress` an object with non-empty
`line1`, `city`, `postalCode`, `country`.

## Configuration (env vars)

All config is read from the environment — nothing is hardcoded.

| Var | Required | Default | Purpose |
| --- | --- | --- | --- |
| `ORDER_TABLE` | yes (in AWS) | — | DynamoDB table name, injected by `app-edge`. |
| `PORT` | no | `3000` | HTTP listen port. |
| `CORS_ALLOWED_ORIGIN` | no | `*` | Value of `Access-Control-Allow-Origin` for the S3-hosted SPA's origin. Set explicitly once the SPA's origin is known; `*` is permissive and intended for local dev only. |
| `DYNAMODB_ENDPOINT` | no (local only) | unset (real DynamoDB) | Overrides the DynamoDB endpoint for local dev against DynamoDB Local. Never set in AWS. |
| `AWS_REGION` | no | `us-east-1` | Only consulted when `DYNAMODB_ENDPOINT` is set; in AWS the SDK/task role supplies region + credentials. |

## Running locally

```bash
docker compose up -d dynamodb-local

# one-time: create the local table (DynamoDB Local does not auto-create it)
aws dynamodb create-table \
  --table-name soa-order \
  --attribute-definitions AttributeName=id,AttributeType=S \
  --key-schema AttributeName=id,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --endpoint-url http://localhost:8000 \
  --region us-east-1

docker compose up --build order
curl -s localhost:3000/health
```

Or run outside Docker: `npm install && DYNAMODB_ENDPOINT=http://localhost:8000 ORDER_TABLE=soa-order npm start`.

## Tests

```bash
npm install
npm test
```

Unit tests (`tests/orders.test.js`) cover validation, total computation, and
status-transition rules with no HTTP or AWS dependency. Route tests
(`tests/routes.test.js`) mock `@aws-sdk/lib-dynamodb`, so `npm test` needs
**no** live DynamoDB Local and **no** AWS credentials — safe to run in CI.

## Known limitations (deliberate, documented)

- **`GET /orders?customerId=` is a `Scan` + `FilterExpression`, not a
  `Query`.** The shared `data` Terraform module provisions a hash-key-only
  table (`id`); there is no GSI on `customerId`. This is correct and free at
  course-demo scale (tens of orders) but does not scale — a GSI is a
  platform change tracked as a follow-up PRD (`product/0001` area), not
  smuggled in here.
- **The API is unauthenticated.** `customerId` is an opaque client-supplied
  string with no verification against a real identity — any caller who can
  reach the service can read or cancel any order. This is the deferred-auth
  posture from [ADR 0004](../../docs/architecture/decisions/0004-frontend-hosting.md)
  (Cognito needs HTTPS, which needs CloudFront) and is accepted knowingly
  for this course-demo scope. Do not put real personal data in this
  service. The fix lands with the HTTPS/Cognito PRD.
