select
  (to_regclass('supabase_migrations.schema_migrations') is not null) as migrations_table_exists;

select 'customers' as table_name, count(*)::bigint as rows from public.customers
union all select 'leads', count(*)::bigint from public.leads
union all select 'lead_events', count(*)::bigint from public.lead_events
union all select 'admin_users', count(*)::bigint from public.admin_users
union all select 'admin_sessions', count(*)::bigint from public.admin_sessions
union all select 'admin_audit_logs', count(*)::bigint from public.admin_audit_logs
union all select 'categories', count(*)::bigint from public.categories
union all select 'products', count(*)::bigint from public.products
union all select 'product_images', count(*)::bigint from public.product_images
union all select 'product_variants', count(*)::bigint from public.product_variants
union all select 'product_variant_images', count(*)::bigint from public.product_variant_images
order by table_name;
