# Network module: a VPC with public subnets only (no NAT gateway, per
# ADR 0001's cost trade-off). ECS/ALB resources in later modules run here
# directly in the public subnets, protected by security groups (added with
# those resources, not here).

# The VPC every resource in the app config lives in.
resource "aws_vpc" "this" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = {
    Name = "${var.name_prefix}-vpc"
  }
}

# Gives the public subnets a route to the internet. No NAT gateway exists
# in this design — everything that needs outbound/inbound internet access
# runs directly in a public subnet behind a security group.
resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id

  tags = {
    Name = "${var.name_prefix}-igw"
  }
}

# One public subnet per entry in public_subnet_cidrs/azs. Using count (not
# for_each) keeps this simple: subnet N always maps to CIDR N and AZ N.
resource "aws_subnet" "public" {
  count = length(var.public_subnet_cidrs)

  vpc_id                  = aws_vpc.this.id
  cidr_block              = var.public_subnet_cidrs[count.index]
  availability_zone       = var.azs[count.index]
  map_public_ip_on_launch = true

  tags = {
    Name = "${var.name_prefix}-public-${count.index}"
  }
}

# A single route table shared by all public subnets, routing all outbound
# traffic to the internet gateway.
resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id

  tags = {
    Name = "${var.name_prefix}-public-rt"
  }
}

resource "aws_route" "public_internet" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.this.id
}

# Associate every public subnet with the shared public route table.
resource "aws_route_table_association" "public" {
  count = length(aws_subnet.public)

  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}
