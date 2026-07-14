# items

Reference ECS microservice — copy this folder to make a new service.

Run `docker-compose up` from the repo root to run it locally against DynamoDB Local.
Edit `src/` for your service's routes and data model; keep `/health` fast and DB-free.
The infra (ALB routing, ECR, task role, DynamoDB table) is wired by the platform in `terraform/app/` — you don't touch that here.

Before first local run, create the local table once (DynamoDB Local, from repo root):
`aws dynamodb create-table --endpoint-url http://localhost:8000 --table-name items --attribute-definitions AttributeName=id,AttributeType=S --key-schema AttributeName=id,KeyType=HASH --billing-mode PAY_PER_REQUEST --region us-east-1`
