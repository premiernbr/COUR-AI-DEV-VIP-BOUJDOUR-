import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool, withTransaction } from "./db.js";

type SeedImage = { url: string; alt?: string; position?: number };
type SeedProduct = {
  name: string;
  slug: string;
  description?: string;
  price: number;
  currency: string;
  popularity?: number;
  category_slug: string;
  main_image_url?: string;
  tags?: string[];
  attributes?: Record<string, unknown>;
  images?: SeedImage[];
};

type SeedData = {
  categories: { slug: string; name: string }[];
  products: SeedProduct[];
};

async function loadSeed(): Promise<SeedData> {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const seedPath = path.resolve(__dirname, "..", "..", "database", "seed-products.json");
  const raw = await fs.readFile(seedPath, "utf-8");
  return JSON.parse(raw) as SeedData;
}

async function seed() {
  const data = await loadSeed();
  await withTransaction(async (client) => {
    const categoryIdBySlug = new Map<string, number>();

    for (const cat of data.categories) {
      const res = await client.query<{ id: number }>(
        `
          INSERT INTO categories (name, slug)
          VALUES ($1, $2)
          ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
          RETURNING id
        `,
        [cat.name, cat.slug]
      );
      categoryIdBySlug.set(cat.slug, res.rows[0].id);
    }

    for (const p of data.products) {
      const categoryId = categoryIdBySlug.get(p.category_slug) ?? null;
      const res = await client.query<{ id: number }>(
        `
          INSERT INTO products (name, slug, description, price, currency, popularity, category_id, main_image_url, tags, attributes, is_active)
          VALUES ($1, $2, $3, $4, $5, COALESCE($6,0), $7, $8, $9, COALESCE($10, '{}'::jsonb), true)
          ON CONFLICT (slug) DO UPDATE SET
            name = EXCLUDED.name,
            description = EXCLUDED.description,
            price = EXCLUDED.price,
            currency = EXCLUDED.currency,
            popularity = EXCLUDED.popularity,
            category_id = EXCLUDED.category_id,
            main_image_url = EXCLUDED.main_image_url,
            tags = EXCLUDED.tags,
            attributes = EXCLUDED.attributes,
            is_active = true,
            updated_at = NOW()
          RETURNING id
        `,
        [
          p.name,
          p.slug,
          p.description ?? null,
          p.price,
          p.currency,
          p.popularity ?? 0,
          categoryId,
          p.main_image_url ?? null,
          p.tags ?? null,
          p.attributes ?? null
        ]
      );

      const productId = res.rows[0].id;
      await client.query(`DELETE FROM product_images WHERE product_id = $1`, [productId]);

      if (p.images && p.images.length) {
        const values = p.images.map((img, idx) => [
          productId,
          img.url,
          img.alt ?? null,
          img.position ?? idx + 1
        ]);
        await client.query(
          `
            INSERT INTO product_images (product_id, url, alt, position)
            SELECT * FROM UNNEST($1::bigint[], $2::text[], $3::text[], $4::int[])
          `,
          [
            values.map((v) => v[0]),
            values.map((v) => v[1]),
            values.map((v) => v[2]),
            values.map((v) => v[3])
          ]
        );
      }
    }
  });
}

seed()
  .then(() => {
    console.log("Seed completed successfully.");
  })
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
