// Small presentational bits shared by the catalog and detail pages, so the
// two screens can't drift on how stock and ratings are rendered.

/**
 * Stock as a coloured pill. "Low stock" starts at 1–5 so the demo shows all
 * three states with a realistic catalog; the threshold is presentational
 * only — the server is the sole authority on whether a decrement succeeds.
 */
export function StockBadge({ stock }: { stock: number }) {
  if (stock === 0) {
    return (
      <span className="badge" data-stock="out">
        Out of stock
      </span>
    );
  }

  if (stock <= 5) {
    return (
      <span className="badge" data-stock="low">
        Only {stock} left
      </span>
    );
  }

  return (
    <span className="badge" data-stock="in">
      In stock
    </span>
  );
}

/** Rating as filled/empty stars plus the numeric value. */
export function Stars({ rating }: { rating: number }) {
  const rounded = Math.round(rating);

  return (
    <span className="rating">
      <span className="rating__stars" aria-hidden="true">
        {'★'.repeat(rounded)}
        {'☆'.repeat(5 - rounded)}
      </span>
      <span>{rating.toFixed(1)}</span>
      <span className="sr-only">out of 5</span>
    </span>
  );
}
