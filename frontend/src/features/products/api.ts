import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../../lib/api';

// Worked example feature — copy this folder's shape (api.ts + a page) when
// adding a new feature. See frontend/README.md "Add a feature" recipe.

export interface Product {
  id: string;
  name: string;
  price: number;
}

export interface CreateProductInput {
  name: string;
  price: number;
}

const PRODUCTS_QUERY_KEY = ['products'] as const;

/** Fetches the product list from the (not-yet-deployed) product service. */
export function useProducts() {
  return useQuery({
    queryKey: PRODUCTS_QUERY_KEY,
    queryFn: () => apiFetch<Product[]>('/products'),
    retry: false,
  });
}

/** Creates a product and refreshes the product list on success. */
export function useCreateProduct() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: CreateProductInput) =>
      apiFetch<Product>('/products', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: PRODUCTS_QUERY_KEY });
    },
  });
}
