import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { errorMessage } from '../../lib/api';
import {
  formatDate,
  formatMoney,
  useAdjustStock,
  useDeleteProduct,
  useProduct,
  useUpdateProduct,
  type UpdateProductInput,
} from './api';
import { StockBadge, Stars } from './ui';

// Product detail — the "product page" half of an Amazon-style storefront:
// image alongside the descriptive fields, and the actions the service
// permits: edit, adjust stock by +/-1 (atomic on the server), and delete.

export function ProductDetailPage() {
  const { id = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: product, isLoading, isError, error } = useProduct(id);

  const updateProduct = useUpdateProduct();
  const deleteProduct = useDeleteProduct();
  const adjustStock = useAdjustStock();

  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [price, setPrice] = useState('');
  const [category, setCategory] = useState('');
  const [imageUrl, setImageUrl] = useState('');

  function startEditing() {
    if (!product) {
      return;
    }
    setName(product.name);
    setDescription(product.description ?? '');
    setPrice(String(product.price));
    setCategory(product.category);
    setImageUrl(product.imageUrl ?? '');
    setEditing(true);
  }

  function handleEditSubmit(e: FormEvent) {
    e.preventDefault();
    const parsedPrice = Number(price);
    if (!name.trim() || !category.trim() || Number.isNaN(parsedPrice)) {
      return;
    }

    const input: UpdateProductInput = {
      name: name.trim(),
      category: category.trim(),
      price: parsedPrice,
      description: description.trim() || undefined,
      imageUrl: imageUrl.trim() || undefined,
    };

    updateProduct.mutate({ id, input }, { onSuccess: () => setEditing(false) });
  }

  function handleDelete() {
    deleteProduct.mutate(id, {
      onSuccess: () => navigate('/products'),
    });
  }

  if (isLoading) {
    return <p>Loading product…</p>;
  }

  if (isError) {
    return (
      <section>
        <p>
          <Link to="/products">← Back to products</Link>
        </p>
        <div role="status">
          <strong>Could not load this product.</strong>{' '}
          <span>{error instanceof Error ? error.message : ''}</span>
        </div>
      </section>
    );
  }

  if (!product) {
    return (
      <section>
        <p>
          <Link to="/products">← Back to products</Link>
        </p>
        <p>Product not found.</p>
      </section>
    );
  }

  return (
    <section>
      <p>
        <Link to="/products">← Back to products</Link>
      </p>

      <div className="product-detail">
        <div className="product-detail__media">
          {product.imageUrl ? (
            <img src={product.imageUrl} alt="" />
          ) : (
            <span className="product-detail__media--empty">No image</span>
          )}
        </div>

        <div>
          <h1>{product.name}</h1>

          <Stars rating={product.rating} />

          <p className="product-detail__price">{formatMoney(product.price)}</p>

          <p>
            <StockBadge stock={product.stock} />
          </p>

          <p className="product-detail__description">
            {product.description || 'No description provided.'}
          </p>

          <dl className="spec-list">
            <dt>Category</dt>
            <dd>{product.category}</dd>
            <dt>Stock</dt>
            <dd>{product.stock}</dd>
            <dt>Rating</dt>
            <dd>{product.rating.toFixed(1)} / 5</dd>
            <dt>Added</dt>
            <dd>{formatDate(product.createdAt)}</dd>
            <dt>Last updated</dt>
            <dd>{formatDate(product.updatedAt)}</dd>
          </dl>

          <h2>Adjust stock</h2>
          <div className="stock-controls">
            <button
              type="button"
              onClick={() => adjustStock.mutate({ id: product.id, delta: -1 })}
              disabled={adjustStock.isPending || product.stock === 0}
              aria-label="Decrease stock by one"
            >
              −
            </button>
            <span className="stock-controls__value">{product.stock}</span>
            <button
              type="button"
              onClick={() => adjustStock.mutate({ id: product.id, delta: 1 })}
              disabled={adjustStock.isPending}
              aria-label="Increase stock by one"
            >
              +
            </button>
            <span className="subtle">Applied atomically — the server refuses to oversell.</span>
          </div>
          {adjustStock.isError && (
            <p role="status">
              <strong>Could not adjust stock.</strong>{' '}
              {errorMessage(adjustStock.error, 'Please try again.')}
            </p>
          )}
        </div>
      </div>

      <h2>Manage</h2>

      {!editing && (
        <div className="form-actions">
          <button type="button" onClick={startEditing}>
            Edit product
          </button>
          {!confirmingDelete && (
            <button type="button" className="btn--danger" onClick={() => setConfirmingDelete(true)}>
              Delete product
            </button>
          )}
        </div>
      )}

      {confirmingDelete && !editing && (
        <div role="status">
          <strong>Delete “{product.name}”?</strong> This cannot be undone.
          <div className="form-actions" style={{ marginTop: 12 }}>
            <button
              type="button"
              className="btn--danger"
              onClick={handleDelete}
              disabled={deleteProduct.isPending}
            >
              {deleteProduct.isPending ? 'Deleting…' : 'Yes, delete it'}
            </button>
            <button type="button" onClick={() => setConfirmingDelete(false)}>
              Keep it
            </button>
          </div>
        </div>
      )}

      {deleteProduct.isError && (
        <p role="status">
          <strong>Could not delete the product.</strong>{' '}
          {errorMessage(deleteProduct.error, 'Please try again.')}
        </p>
      )}

      {editing && (
        <form onSubmit={handleEditSubmit}>
          <div className="form-grid">
            <label className="field">
              <span>Name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="field">
              <span>Category</span>
              <input value={category} onChange={(e) => setCategory(e.target.value)} />
            </label>
            <label className="field">
              <span>Price</span>
              <input
                type="number"
                step="0.01"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
              />
            </label>
            <label className="field form-grid--wide">
              <span>Image URL</span>
              <input value={imageUrl} onChange={(e) => setImageUrl(e.target.value)} />
            </label>
            <label className="field form-grid--wide">
              <span>Description</span>
              <textarea
                rows={3}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </label>
          </div>

          <div className="form-actions">
            <button type="submit" disabled={updateProduct.isPending}>
              {updateProduct.isPending ? 'Saving…' : 'Save changes'}
            </button>
            <button type="button" onClick={() => setEditing(false)}>
              Cancel
            </button>
            <span className="subtle">Stock is changed above, not here.</span>
          </div>

          {updateProduct.isError && (
            <p role="status">
              <strong>Could not update the product.</strong>{' '}
              {errorMessage(updateProduct.error, 'Please try again.')}
            </p>
          )}
        </form>
      )}
    </section>
  );
}
