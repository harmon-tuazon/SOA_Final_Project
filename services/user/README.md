# user

ECS Fargate microservice owning a shopper's **profile** and **billing
information**, authenticated against Amazon Cognito. Built to
[`docs/action_plan/user/0001-user-service.md`](../../docs/action_plan/user/0001-user-service.md)
and the [service contract](../../.claude/rules/service-contract.md).

## What it does

Cognito is the source of truth for credentials, email, and verification
status — this service verifies the caller's **ID token** against the pool's
public JWKS (no shared secret, no outbound Cognito call) and owns only what
Cognito does not: a `displayName`/`phone` profile and an optional billing
sub-object, keyed by the token's `sub` claim. There is no `/users/:id` —
every route resolves the caller from their own verified token, so one user
can never address another's record.

**No raw card data is ever accepted.** `PUT /users/me/billing` rejects,
before any write or any logging, a body containing a PAN/CVV-shaped key or a
13–19 digit value (see the PAN/CVV guard below).

## Routes

| Method | Path | Auth | Behaviour |
| --- | --- | --- | --- |
| `GET` | `/health` | none | `200 OK`, plain text. Fast, DB-free — the ALB target-group health check. |
| `GET` | `/users/me` | Bearer | The caller's profile, **lazily creating** the row from the token's claims on first call. `200`. |
| `PUT` | `/users/me` | Bearer | Updates `displayName`/`phone` only; any other field (including `userId`/`email`) is ignored. `200`; `400` on an invalid body. |
| `GET` | `/users/me/billing` | Bearer | The billing sub-object. `200`, or `404` if never set. |
| `PUT` | `/users/me/billing` | Bearer | Sets/replaces billing. `200`; `400` on an invalid shape **or** on any PAN/CVV present (writes nothing in either case). |
| `DELETE` | `/users/me/billing` | Bearer | Removes the billing sub-object. `204`, idempotent (also `204` when absent). |
| `OPTIONS` | `/users*` | none | CORS preflight. `204`. |

Missing/invalid/expired/wrong-audience token → `401 { error }` on every
protected route.

### Profile fields

`displayName` (string, ≤ 100 chars) and `phone` (string, optional, ≤ 30
chars) are the only user-editable fields. `userId` (the Cognito `sub`) and
`email` (from the token's `email` claim) are server-set and read-only via
this API.

### Billing shape (`PUT /users/me/billing`)

```json
{
  "cardholderName": "Jane Doe",
  "cardBrand": "VISA",
  "cardLast4": "1234",
  "cardExpMonth": 6,
  "cardExpYear": 2027,
  "paymentMethodToken": "tok_abc123",
  "billingAddress": {
    "line1": "123 Main St",
    "city": "Toronto",
    "postalCode": "M5V 2T6",
    "country": "CA"
  }
}
```

`cardBrand` one of `VISA`, `MASTERCARD`, `AMEX`, `DISCOVER`; `cardLast4`
exactly 4 digits; `cardExpMonth` an integer 1–12; `cardExpYear` an integer
between the current year and current year + 20; `paymentMethodToken` an
opaque stand-in for a PSP token — **no PSP is integrated and no card number
or CVV is ever stored.**

### The PAN/CVV guard (binding — PRD §3.3)

`PUT /users/me/billing` walks the **entire** request body, including nested
objects and arrays, and rejects with `400` — before any write and before any
logging — if it finds:

- a key matching `/^(card)?(number|pan|cvv|cvc|securitycode)$/i` (e.g.
  `cardNumber`, `number`, `pan`, `cvv`, `cvc`, `securityCode`), or
- any string value that is 13–19 digits once spaces and dashes are
  stripped (a raw card number shape).

`cardLast4` (4 digits) and `paymentMethodToken` do not trip this check.
Billing request bodies are never logged, on success or failure.

## Configuration (env vars)

All config is read from the environment — nothing is hardcoded.

| Var | Required | Default | Purpose |
| --- | --- | --- | --- |
| `USER_TABLE` | yes (in AWS) | — | DynamoDB table name, injected by `app-edge`. |
| `COGNITO_USER_POOL_ID` | yes (to verify tokens) | — | The Cognito user pool whose public JWKS this service verifies ID tokens against. |
| `COGNITO_CLIENT_ID` | yes (to verify tokens) | — | The SPA's Cognito app client id — enforced as the token's audience. |
| `PORT` | no | `3000` | HTTP listen port. |
| `CORS_ALLOWED_ORIGIN` | no | `*` | Value of `Access-Control-Allow-Origin` for the S3-hosted SPA's origin. The SPA sends an `Authorization` header, so **every** call is preflighted — an incorrect origin breaks the app even when the ALB is reachable. `*` is permissive and intended for local dev only. |
| `DYNAMODB_ENDPOINT` | no (local only) | unset (real DynamoDB) | Overrides the DynamoDB endpoint for local dev against DynamoDB Local. Never set in AWS. |
| `AWS_REGION` | no | `us-east-1` | Only consulted when `DYNAMODB_ENDPOINT` is set; in AWS the SDK/task role supplies region + credentials. |

If `COGNITO_USER_POOL_ID`/`COGNITO_CLIENT_ID` are unset, every protected
route responds `401 { "error": "Auth not configured" }` rather than
crashing — the verifier is built lazily on first use, so simply requiring
this service's code (e.g. `/health`, or running the test suite) never
throws for missing Cognito config.

## Running locally

```bash
docker compose up -d dynamodb-local

# one-time: create the local table (DynamoDB Local does not auto-create it)
aws dynamodb create-table \
  --table-name soa-user \
  --attribute-definitions AttributeName=userId,AttributeType=S \
  --key-schema AttributeName=userId,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --endpoint-url http://localhost:8000 \
  --region us-east-1

docker compose up --build user
curl -s localhost:3001/health                                     # 200, no token
curl -s -o /dev/null -w '%{http_code}' localhost:3001/users/me    # 401 (no COGNITO_* set locally)
```

Or run outside Docker: `npm install && DYNAMODB_ENDPOINT=http://localhost:8000 USER_TABLE=soa-user npm start`.

`COGNITO_USER_POOL_ID`/`COGNITO_CLIENT_ID` are left unset in
`docker-compose.yml` on purpose — there is no local Cognito pool to verify
against, so every protected route correctly returns `401` locally. Set both
(pointed at a real pool) to exercise an authenticated flow outside AWS.

## Tests

```bash
npm install
npm test
```

- `tests/users.test.js` — profile/billing validation and every PAN/CVV
  guard case, with no HTTP or AWS dependency.
- `tests/auth.test.js` — token verification middleware, with
  `aws-jwt-verify` mocked (missing header, rejected verification, resolved
  verification, and the "auth not configured" path).
- `tests/routes.test.js` — full route behaviour against an in-memory
  DynamoDB stand-in (mocking `@aws-sdk/lib-dynamodb`) and a mocked
  verifier: lazy profile creation, `PUT /users/me` stripping
  `userId`/`email`, the billing round trip, `DELETE` idempotency, and the
  PAN/CVV guard writing nothing.
- `tests/health.test.js` — `/health` returns `200` with zero env set.

`npm test` needs **no** live DynamoDB Local, **no** AWS credentials, and
**no** network — safe to run in CI.

## Known limitations (deliberate, documented)

- **No async path.** No `UserRegistered` event is published on first
  upsert; that's the reserved `platform/0008` messaging factory, then
  `user/0002`.
- **Order service does not (yet) enforce this identity.** `order`'s
  `customerId` remains an opaque, unauthenticated client-supplied string —
  see [`user/0001` §9.2](../../docs/action_plan/user/0001-user-service.md#92-known-gap-this-prd-deliberately-leaves-open).
- **Tokens travel over plain HTTP** between the SPA and the ALB (no
  CloudFront/HTTPS yet) — an accepted, documented limitation of this
  disposable course environment. See
  [`user/0001` §9.1](../../docs/action_plan/user/0001-user-service.md#91-security-posture).
