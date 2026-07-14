# _template

This is the service template — do **NOT** edit or deploy it directly. Copy it
(usually via `/new-service`) to `services/<name>/` and the placeholders get
filled in for you.

## Placeholder tokens

| Token | Becomes | Where it appears |
| --- | --- | --- |
| `__SERVICE_NAME__` | The service's name (kebab-case) | `package.json` (`name`), `src/index.js` (log line), container/ECS naming |
| `__RESOURCE__` | The REST resource/route noun (e.g. `items`, `orders`) | `src/app.js` routes: `GET /__RESOURCE__`, `POST /__RESOURCE__` |
| `__TABLE_ENV__` | The env var name holding this service's DynamoDB table name (e.g. `ITEMS_TABLE`) | `src/app.js` (`process.env.__TABLE_ENV__`) |

Everything else (Dockerfile, `.dockerignore`, `.gitignore`, the `/health`
endpoint, the DynamoDB client + `DYNAMODB_ENDPOINT` local-override pattern,
test setup) is generic and copies over unchanged.
