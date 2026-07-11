# Microservices Project Design (AWS-Native)

## Project Overview

In this project, students design, develop, and deploy a microservices-based application that simulates a real-world use case, running on **Amazon Web Services (AWS)**. The project involves creating multiple independent services, each responsible for a specific functionality, and ensuring seamless communication between them. Students containerize the synchronous microservices using Docker, publish the images to **Amazon Elastic Container Registry (ECR)**, and run them on **Amazon ECS with the Fargate launch type** (serverless containers — no servers to manage). Event-driven, decoupled work runs on **AWS Lambda** triggered through **Amazon SQS**. This hybrid gives practical experience with both containerized orchestration and event-driven serverless patterns on a real cloud platform.

Local development uses Docker Compose for fast iteration; the cloud target is ECS Fargate + Lambda.

> **Compute choice:** managed Kubernetes (EKS) was evaluated and rejected on cost (~$120–150/mo idle). ECS Fargate delivers the same container + orchestration learning at a fraction of the cost. See [ADR 0001](docs/architecture/decisions/0001-platform-and-compute-architecture.md), which also tracks the open risk against the rubric's literal "Kubernetes" wording.

## Key Activities

- **Microservices Design and Development**
  - Design modular services with distinct responsibilities.
  - Implement RESTful APIs for synchronous interaction, and event-driven messaging for decoupled work.
- **Containerization**
  - Write Dockerfiles for each synchronous microservice to create container images.
  - Use Docker Compose for local multi-container development and testing.
  - Push images to **Amazon ECR**.
- **AWS Deployment (ECS Fargate + Lambda)**
  - Define **ECS task definitions and services** for the containerized microservices, fronted by an **Application Load Balancer (ALB)**.
  - Implement **decoupled async services** with **SQS → Lambda → SNS** (e.g. notifications/email).
  - Provision all AWS resources with **Terraform** (VPC, ECS, ECR, ALB, DynamoDB, SQS/SNS, IAM, CloudWatch).
- **Monitoring and Testing**
  - Use **Amazon CloudWatch** for metrics and **CloudWatch Logs** for centralized logging.
  - Write unit, integration, and end-to-end tests for reliability.
- **CI/CD Pipeline**
  - Automate the build, test, and deployment process using **GitHub Actions**, deploying container images to ECS and packages to Lambda.

This project aims to provide a comprehensive understanding of modern cloud-native development practices, preparing students to handle complex, distributed systems on a real cloud provider.

## Project Phases

### Part 1: Microservices Design and Dockerization

- **Deliverables:**
  - Design and implement the core microservices (at least two functional services).
  - Create and test RESTful APIs for each service.
  - Dockerize the synchronous services with functional, optimized Dockerfiles.
  - Submit a Docker Compose file for local testing, and publish images to Amazon ECR.
- **Focus:** Modular design, Docker best practices, and ensuring API functionality.

### Part 2: AWS Deployment (ECS Fargate + Lambda)

- **Deliverables:**
  - Write and test **ECS task definitions and service definitions** for the containerized services.
  - Provision the ECS cluster, ALB, and supporting AWS infrastructure with Terraform, and deploy the services to it.
  - Implement at least one **decoupled async path** (SQS → Lambda → SNS).
  - Ensure networking (ALB routing, security groups), scaling (**ECS Service Auto Scaling**), and service discovery (**ECS Service Connect / AWS Cloud Map**) are functional.
- **Focus:** Container orchestration on ECS, event-driven decoupling, and infrastructure-as-code.

### Part 3: Testing, CI/CD, and Monitoring

- **Deliverables:**
  - Implement unit, integration, and end-to-end tests for the microservices.
  - Set up a CI/CD pipeline (GitHub Actions) to automate testing and deployment to ECS and Lambda.
  - Integrate monitoring (CloudWatch metrics/alarms) and centralized logging (CloudWatch Logs).
- **Focus:** Testing reliability, automation, and observability.

### Part 4: Final Presentation

- **Deliverables:**
  - A comprehensive presentation to demonstrate the entire project.
  - Highlight architecture, functionality, deployment process, challenges faced, and key learnings.
  - Showcase the working application (e.g., live demo or recorded walkthrough).
- **Focus:** Communication, clarity, and technical depth in presenting the project.

## Suggested Microservices

- **User Service:** Handles user registration, authentication, and profiles.
- **Product Service:** Manages product catalogs.
- **Order Service:** Processes user orders.
- **Notification Service:** Sends email or SMS notifications (async — a good fit for Lambda + SQS/SNS).

## Rubric

### 1. Architecture and Design (4 points)

- **Microservices Design:**
  - Each microservice should be modular and serve a specific purpose.
  - APIs should follow RESTful conventions.
  - Services should communicate effectively (synchronous via HTTP, asynchronous via a message queue such as **Amazon SQS/SNS**).
- **Database Design:**
  - Use a separate database per microservice (polyglot persistence where possible, e.g. **Amazon DynamoDB**).
- **Service Discovery:**
  - Implement a service discovery mechanism (e.g., **ECS Service Connect** or **AWS Cloud Map**).
- **Documentation:**
  - Provide architecture diagrams (e.g., sequence diagrams, service interactions).

### 2. Docker Implementation (3 points)

- **Docker Images:**
  - Create lightweight and optimized Dockerfiles for each containerized service.
  - Use multistage builds where applicable.
  - Publish images to Amazon ECR.
- **Docker Compose:**
  - Provide a Docker Compose file to run the project locally.
- **Security Best Practices:**
  - Avoid using root users in Docker containers.
  - Use environment variables / **SSM Parameter Store** for sensitive information.

### 3. Container Orchestration — ECS Fargate (4 points)

- **Task & Service Definitions:**
  - Provide ECS task definitions and service definitions for the containerized services, plus Lambda/SQS/SNS definitions for the async path.
- **Scalability:**
  - Configure **ECS Service Auto Scaling** for at least one service.
- **Networking:**
  - Use an **ALB** for external routing and **security groups** for controlled communication.
- **Monitoring and Logging:**
  - Integrate CloudWatch metrics/alarms for monitoring.
  - Use centralized logging (CloudWatch Logs).
- **Security:**
  - Implement least-privilege **IAM task roles** (per-service) and scoped security groups.

### 4. Testing (1.5 points)

- **Unit Tests:**
  - Each service should include unit tests for core functionality.
- **Integration Tests:**
  - Test communication between microservices (including the SQS/Lambda path).
- **End-to-End Tests:**
  - Test the entire application flow.

### 5. Deployment and CI/CD (1.5 points)

- **CI/CD Pipeline:**
  - Implement a pipeline using GitHub Actions.
  - Automate building, testing, and deploying container images to ECS and packages to Lambda.
- **Deployment Strategy:**
  - Demonstrate rolling updates (ECS rolling deployment) or a canary/blue-green approach.

### Weekly group meeting (6 marks)

- Meet in weeks 9, 10, 11, and 12.
- All members must present their progress during the lab session.

## Deliverables

- **Code Repository:** Hosted on GitHub with clear README instructions.
- **Docker Images:** Published to Amazon ECR.
- **Infrastructure & Deployment Files:** Terraform for AWS resources, ECS task/service definitions, and Lambda packaging, configured for deployment.
- **Documentation:** Includes setup, architecture, and usage instructions.
- **Cloud Demo:** Demonstration of the application running on ECS Fargate + Lambda.
- **Final Presentation:** A comprehensive presentation to demonstrate the entire project, including architecture, functionality, deployment, and learnings.

## Tips for Success

- Follow SOLID principles for microservices design.
- Use lightweight and scalable technologies.
- Be cost-conscious: stay within the AWS Free Tier where possible, avoid always-on resources (NAT gateways, idle load balancers), and tear down cloud resources (`terraform destroy`) when not in use.
- Ensure clear communication between team members and use Git workflows.
- Test thoroughly to ensure reliability and robustness of the application.

## Hints for Students

- **Start Small:** Begin by designing a single microservice and its data model. Validate its functionality before adding other services.
- **Leverage Examples:** Look at sample Dockerfiles, Terraform modules, and ECS task definitions for guidance but adapt them to your specific needs.
- **Use Tools:** Use Postman or similar tools to test your APIs. The AWS Console and CloudWatch help observe the cloud side.
- **Debugging:** Check logs frequently — `docker logs` for local containers, and CloudWatch Logs for the deployed ECS services and Lambda functions.
- **Cloud Setup:** Provision everything with Terraform so the environment is reproducible and destroyable; watch your AWS spend and set a budget alarm.
- **Version Control:** Commit code frequently and use meaningful commit messages to track your progress.
- **Documentation:** Document every step you take. This helps during debugging and when preparing your final submission.
- **Ask Questions:** If you're stuck, don't hesitate to seek help from peers, forums, or the internet. Collaboration is key in real-world projects.
- **Test Continuously:** Test each service in isolation and integration regularly to ensure there are no hidden bugs.
- **Iterate:** It's okay if your first attempt doesn't work perfectly. Iterate and improve as you learn.
