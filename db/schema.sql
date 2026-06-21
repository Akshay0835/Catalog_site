-- Enable WAL mode for better concurrent performance
PRAGMA journal_mode = WAL;

-- Create products table
CREATE TABLE IF NOT EXISTS products (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    price REAL NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

-- Compound index for fast global browsing (newest first)
CREATE INDEX IF NOT EXISTS idx_products_created_id 
ON products (created_at DESC, id DESC);

-- Compound index for fast category-filtered browsing (newest first)
CREATE INDEX IF NOT EXISTS idx_products_category_created_id 
ON products (category, created_at DESC, id DESC);
