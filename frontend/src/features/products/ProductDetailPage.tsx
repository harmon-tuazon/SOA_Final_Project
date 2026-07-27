import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { errorMessage } from '../../lib/api';
import {
  formatMoney,
  useAdjustStock,
  useDeleteProduct,
  useProduct,
  useUpdateProduct,
  type UpdateProductInput,
} from './api';

// Product detail — the "product page" half of an Amazon-style storefront:
// full description, price/category/rating/stock, and the actions the
// service permits: edit the descriptive fields, adjust stock by +/-1
// (atomic on the server), and delete.

export function ProductDetailPage() {
  const { id = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: product, isLoading, isError, error } = useProduct(id);

  const updateProduct = useUpdateProduct();
  const deleteProduct = useDeleteProduct();
  const adjustStock = useAdjustStock();

  const [editing, setEditing] = useState(false);
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

      <h1>{product.name}</h1>

      {product.imageUrl ? (
        <img src={product.imageUrl} alt={product.name} width={240} />
      ) : (
        <p>No image</p>
      )}

      <p>{product.description || 'No description provided.'}</p>

      <dl>
        <dt>Price</dt>
        <dd>{formatMoney(product.price)}</dd>
        <dt>Category</dt>
        <dd>{product.category}</dd>
        <dt>Rating</dt>
        <dd>{product.rating.toFixed(1)} / 5</dd>
        <dt>Stock</dt>
        <dd>{product.stock === 0 ? 'Out of stock' : product.stock}</dd>
        <dt>Last updated</dt>
        <dd>{product.updatedAt}</dd>
      </dl>

      <h2>Stock</h2>
      <p>
        <button
          type="button"
          onClick={() => adjustStock.mutate({ id: product.id, delta: -1 })}
          disabled={adjustStock.isPending || product.stock === 0}
        >
          − 1
        </button>{' '}
        <button
          type="button"
          onClick={() => adjustStock.mutate({ id: product.id, delta: 1 })}
          disabled={adjustStock.isPending}
        >
          + 1
        </button>
      </p>
      {adjustStock.isError && (
        <p role="status">
          <strong>Could not adjust stock.</strong>{' '}
          {errorMessage(adjustStock.error, 'Please try again.')}
        </p>
      )}

      <h2>Edit</h2>
      {!editing && (
        <button type="button" onClick={startEditing}>
          Edit product
        </button>
      )}
      {editing && (
        <form onSubmit={handleEditSubmit}>
          <label>
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label>
            Description
            <input value={description} onChange={(e) => setDescription(e.target.value)} />
          </label>
          <label>
            Price
            <input
              type="number"
              step="0.01"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
            />
          </label>
          <label>
            Category
            <input value={category} onChange={(e) => setCategory(e.target.value)} />
          </label>
          <label>
            Image URL
            <input value={imageUrl} onChange={(e) => setImageUrl(e.target.value)} />
          </label>
          <button type="submit" disabled={updateProduct.isPending}>
            {updateProduct.isPending ? 'Saving…' : 'Save'}
          </button>{' '}
          <button type="button" onClick={() => setEditing(false)}>
            Cancel
          </button>
          {updateProduct.isError && (
            <p role="status">
              <strong>Could not update the product.</strong>{' '}
              {errorMessage(updateProduct.error, 'Please try again.')}
            </p>
          )}
        </form>
      )}

      <h2>Danger zone</h2>
      <button type="button" onClick={handleDelete} disabled={deleteProduct.isPending}>
        {deleteProduct.isPending ? 'Deleting…' : 'Delete product'}
      </button>
      {deleteProduct.isError && (
        <p role="status">
          <strong>Could not delete the product.</strong>{' '}
          {errorMessage(deleteProduct.error, 'Please try again.')}
        </p>
      )}
    </section>
  );
}
