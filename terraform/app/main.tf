# Wires the app config's modules together. This is a thin root: modules do
# the actual resource creation, this file just passes inputs between them.

# The set of Availability Zones currently available to this account/region,
# used to spread the public subnets across zones without hardcoding names.
data "aws_availability_zones" "available" {
  state = "available"
}

module "network" {
  source = "./modules/network"

  name_prefix         = var.name_prefix
  vpc_cidr            = var.vpc_cidr
  public_subnet_cidrs = var.public_subnet_cidrs
  azs                 = slice(data.aws_availability_zones.available.names, 0, length(var.public_subnet_cidrs))
}
