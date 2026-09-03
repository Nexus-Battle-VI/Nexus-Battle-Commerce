import { sql, type Kysely } from 'kysely'

export const up = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema
    .alterTable('orders')
    .addColumn('version', 'integer', (c) => c.notNull().defaultTo(0))
    .execute()
  await db.schema.alterTable('orders').dropConstraint('orders_estado_conocido').execute()
  await db.schema
    .alterTable('orders')
    .addCheckConstraint(
      'orders_estado_conocido',
      sql`status in ('DRAFT','PROCESSING','CONFIRMED','CANCELLED')`,
    )
    .execute()
  for (const table of ['order_lines', 'wishlist_items', 'saved_cart_items']) {
    const constraint =
      table === 'order_lines'
        ? 'order_lines_sku_normalizada'
        : table === 'wishlist_items'
          ? 'wishlist_items_sku_normalizada'
          : 'saved_cart_items_sku_normalizada'
    await sql`alter table ${sql.table(table)} drop constraint if exists ${sql.id(constraint)}`.execute(
      db,
    )
    await sql`alter table ${sql.table(table)} add constraint ${sql.id(constraint)} check (sku ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$' or sku ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')`.execute(
      db,
    )
  }
  await db.schema
    .alterTable('order_lines')
    .addColumn('product_id', 'text')
    .addColumn('catalog_sku', 'text')
    .addColumn('product_name', 'text')
    .addColumn('image_url', 'text')
    .execute()
  await db.schema
    .alterTable('saved_cart_items')
    .addColumn('product_id', 'text')
    .addColumn('catalog_sku', 'text')
    .addColumn('product_name', 'text')
    .addColumn('image_url', 'text')
    .execute()
  // Fail visibly if legacy data contains multiple live carts. Never delete customer data to migrate.
  await sql`create unique index orders_one_live_cart on orders(customer_id) where status in ('DRAFT','PROCESSING')`.execute(
    db,
  )
  await db.schema
    .createTable('purchase_attempts')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('order_id', 'text', (c) => c.notNull().references('orders.id'))
    .addColumn('customer_id', 'text', (c) => c.notNull())
    .addColumn('state', 'text', (c) => c.notNull())
    .addColumn('payload', 'jsonb', (c) => c.notNull())
    .addColumn('failure', 'text')
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('next_attempt_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addCheckConstraint(
      'purchase_state_valid',
      sql`state in ('RESERVING','RESERVED','DELIVERED','RELEASING','COMPLETED','FAILED')`,
    )
    .execute()
  await sql`create unique index purchase_one_active_attempt on purchase_attempts(order_id) where state <> 'FAILED'`.execute(
    db,
  )
  await db.schema
    .createIndex('purchase_by_order')
    .on('purchase_attempts')
    .columns(['order_id', 'updated_at'])
    .execute()
  await sql`create index purchase_attempt_due on purchase_attempts(next_attempt_at, id) where state not in ('COMPLETED','FAILED')`.execute(
    db,
  )
  await db.schema
    .createTable('purchase_mail_outbox')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('payload', 'jsonb', (c) => c.notNull())
    .addColumn('sent_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('next_attempt_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute()
  await sql`create index purchase_mail_due on purchase_mail_outbox(next_attempt_at, id) where sent_at is null`.execute(
    db,
  )
}

/**
 * Forward-only: the old schema cannot preserve the purchase ledger, outbox,
 * canonical product identities or processing orders. Deploy a compensating
 * forward migration after recovery instead of deleting purchase evidence.
 */
export const down = (): Promise<void> =>
  Promise.reject(
    new Error(
      'La migracion 004 solo admite avance: no se elimina el historial de compras, outbox ni referencias canonicas. Usa una migracion compensatoria.',
    ),
  )
