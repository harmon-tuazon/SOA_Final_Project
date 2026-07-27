import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../../lib/api';

// Product feature — talks to the `product` service (services/product/) through
// the shared apiFetch wrapper, so the ALB base URL stays a runtime config
// value and is never hardcoded here. See
// docs/action_plan/product/0001-service-scaffold.md and
// docs/operations/adding-a-frontend-feature.md.

export interface Product {
  id: string;
  name: string;
  description?: string;
  price: number;
  category: string;
  imageUrl?: string;
  stock: number;
  rating: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * What the client may send on create. The server derives id, createdAt and
 * updatedAt and ignores any client-supplied values for them — so they are
 * deliberately absent from this type (the same pattern as CreateOrderInput).
 */
export interface CreateProductInput {
  name: string;
  description?: string;
  price: number;
  category: string;
  imageUrl?: string;
  stock?: number;
}

/**
 * What the client may send on a partial update. `id`/`createdAt`/`updatedAt`
 * are server-owned (omitted, as on create); `stock` is also omitted here —
 * it only moves through the dedicated atomic `useAdjustStock` mutation.
 */
export type UpdateProductInput = Partial<Omit<CreateProductInput, 'stock'>>;

export interface ProductFilters {
  /** Exact-match filter on category. */
  category?: string;
  /** Case-insensitive substring match on name + description. */
  q?: string;
}

const PRODUCTS_KEY = ['products'] as const;

const productKey = (id: string) => ['products', id] as const;

function buildQuery(filters?: ProductFilters): string {
  if (!filters) {
    return '';
  }
  const params = new URLSearchParams();
  if (filters.category) {
    params.set('category', filters.category);
  }
  if (filters.q) {
    params.set('q', filters.q);
  }
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

/**
 * Lists the catalog, newest first. Category/search are passed as query
 * params so filtering happens server-side (a DynamoDB Scan + FilterExpression
 * per the service, not a client-side filter of the full list).
 */
export function useProducts(filters?: ProductFilters) {
  return useQuery({
    queryKey: [...PRODUCTS_KEY, filters ?? {}],
    queryFn: () => apiFetch<Product[]>(`/products${buildQuery(filters)}`),
    retry: false,
  });
}

/** Fetches a single product for the detail page. */
export function useProduct(id: string) {
  return useQuery({
    queryKey: productKey(id),
    queryFn: () => apiFetch<Product>(`/products/${encodeURIComponent(id)}`),
    retry: false,
    enabled: Boolean(id),
  });
}

/** Creates a product and refreshes the catalog on success. */
export function useCreateProduct() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: CreateProductInput) =>
      apiFetch<Product>('/products', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: PRODUCTS_KEY });
    },
  });
}

/** Partially updates a product's non-stock fields. */
export function useUpdateProduct() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateProductInput }) =>
      apiFetch<Product>(`/products/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    onSuccess: (product) => {
      queryClient.invalidateQueries({ queryKey: PRODUCTS_KEY });
      queryClient.invalidateQueries({ queryKey: productKey(product.id) });
    },
  });
}

/**
 * Deletes a product. The service answers 204 with no body, which apiFetch
 * resolves to `undefined` rather than attempting to parse JSON.
 */
export function useDeleteProduct() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<void>(`/products/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: (_result, id) => {
      queryClient.invalidateQueries({ queryKey: PRODUCTS_KEY });
      queryClient.removeQueries({ queryKey: productKey(id) });
    },
  });
}

/**
 * Adjusts stock by a signed delta via the atomic conditional endpoint. The
 * service answers 409 (not 200) when the adjustment would take stock
 * negative — callers should surface that error rather than assume success.
 * Refetches the product afterwards rather than trusting the mutation
 * response shape for display.
 */
export function useAdjustStock() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, delta }: { id: string; delta: number }) =>
      apiFetch<{ stock: number }>(`/products/${encodeURIComponent(id)}/stock`, {
        method: 'PATCH',
        body: JSON.stringify({ delta }),
      }),
    onSuccess: (_result, { id }) => {
      queryClient.invalidateQueries({ queryKey: PRODUCTS_KEY });
      queryClient.invalidateQueries({ queryKey: productKey(id) });
    },
  });
}

export function formatMoney(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

export function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString();
}
