-- Catalog expansion: support product variants and storage-path-based images

alter table public.products
  add column if not exists main_image_path text;

alter table public.product_images
  add column if not exists storage_path text;

create table if not exists public.product_variants (
  id bigserial primary key,
  product_id bigint not null references public.products(id) on delete cascade,
  name text not null,
  slug text not null,
  sku text,
  description text,
  price numeric(12, 2) not null,
  currency text not null default 'MAD',
  sort_order int not null default 1,
  attributes jsonb not null default '{}'::jsonb,
  main_image_path text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint product_variants_product_slug_unique unique (product_id, slug)
);

create unique index if not exists idx_product_variants_sku_unique
  on public.product_variants (sku)
  where sku is not null;

create index if not exists idx_product_variants_product_active_sort
  on public.product_variants (product_id, is_active, sort_order, id);

create table if not exists public.product_variant_images (
  id bigserial primary key,
  variant_id bigint not null references public.product_variants(id) on delete cascade,
  storage_path text not null,
  alt text,
  position int not null default 1
);

create index if not exists idx_product_variant_images_variant_position
  on public.product_variant_images (variant_id, position, id);

create index if not exists idx_product_images_product_position
  on public.product_images (product_id, position, id);

