import { sql, type Kysely } from 'kysely'

export const up = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema
    .createTable('purchase_premium_notices')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('product_id', 'text', (c) => c.notNull())
    .addColumn('sent_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('next_attempt_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute()
  await sql`create index purchase_premium_notice_due on purchase_premium_notices(next_attempt_at, id) where sent_at is null`.execute(
    db,
  )
}

/**
 * Forward-only, mismo criterio que 004: no se elimina evidencia de que Catalog
 * fue notificado de una compra premium.
 */
export const down = (): Promise<void> =>
  Promise.reject(
    new Error(
      'La migracion 005 solo admite avance: no se elimina el historial de avisos de compra premium. Usa una migracion compensatoria.',
    ),
  )
