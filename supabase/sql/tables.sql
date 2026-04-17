select table_schema, table_name
from information_schema.tables
where table_type = 'BASE TABLE'
  and table_schema in ('public', 'supabase_migrations')
order by table_schema, table_name;

