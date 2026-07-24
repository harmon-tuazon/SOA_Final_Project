import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch, ApiError } from '../../lib/api';

// User feature — talks to the `user` service (services/user/) through the
// shared apiFetch wrapper. Every route here is Bearer-protected; apiFetch
// attaches the token automatically once AuthProvider has a session (see
// lib/api.ts's setAuthTokenGetter). See docs/action_plan/user/0001-user-service.md.

export interface UserProfile {
  userId: string;
  /** Owned by Cognito — read-only through this API. */
  email: string;
  displayName: string;
  phone: string;
  createdAt: string;
  updatedAt: string;
}

/** What the client may edit. The service ignores userId/email if sent. */
export interface UpdateProfileInput {
  displayName: string;
  phone: string;
}

export type CardBrand = 'VISA' | 'MASTERCARD' | 'AMEX' | 'DISCOVER';

export interface BillingAddress {
  line1: string;
  city: string;
  postalCode: string;
  country: string;
}

export interface Billing {
  cardholderName: string;
  cardBrand: CardBrand;
  cardLast4: string;
  cardExpMonth: number;
  cardExpYear: number;
  paymentMethodToken: string;
  billingAddress: BillingAddress;
}

const ME_KEY = ['users', 'me'] as const;
const BILLING_KEY = ['users', 'me', 'billing'] as const;

/** Fetches (and, on the service side, lazily creates) the caller's profile. */
export function useMe() {
  return useQuery({
    queryKey: ME_KEY,
    queryFn: () => apiFetch<UserProfile>('/users/me'),
    retry: false,
  });
}

/** Updates displayName/phone and refreshes the cached profile on success. */
export function useUpdateMe() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: UpdateProfileInput) =>
      apiFetch<UserProfile>('/users/me', {
        method: 'PUT',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ME_KEY });
    },
  });
}

/** Fetches the caller's billing info. Resolves null (not an error) when none is set (404). */
export function useBilling() {
  return useQuery({
    queryKey: BILLING_KEY,
    queryFn: async (): Promise<Billing | null> => {
      try {
        return await apiFetch<Billing>('/users/me/billing');
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) {
          return null;
        }
        throw err;
      }
    },
    retry: false,
  });
}

/** Sets/replaces billing info and refreshes the cached value on success. */
export function usePutBilling() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: Billing) =>
      apiFetch<Billing>('/users/me/billing', {
        method: 'PUT',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: BILLING_KEY });
    },
  });
}

/** Removes the caller's billing info. */
export function useDeleteBilling() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => apiFetch<void>('/users/me/billing', { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: BILLING_KEY });
    },
  });
}
