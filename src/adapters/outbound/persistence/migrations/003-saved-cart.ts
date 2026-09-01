import { sql, type Kysely } from 'kysely'

/**
 * Carrito guardado entre sesiones de HU-61.
 *
 * Sin clave foranea hacia `orders`: el carrito guardado sobrevive al pedido
 * del que se copio, y encadenarlos borraria lo guardado al confirmar la
 * compra, que es justo lo contrario de lo que pide la historia.
 */
export const up = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema
    .createTable('saved_cart_items')
    // Sin clave foranea: el cliente vive en Account.
    .addColumn('customer_id', 'text', (col) => col.notNull())
    .addColumn('sku', 'text', (col) => col.notNull())
    .addColumn('currency', 'text', (col) => col.notNull())
    .addColumn('unit_price_amount', 'bigint', (col) => col.notNull())
    .addColumn('quantity', 'integer', (col) => col.notNull())
    .addColumn('saved_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    // (cliente, referencia) es la clave: una referencia ocupa como mucho una
    // linea del carrito guardado, igual que en el pedido.
    .addPrimaryKeyConstraint('saved_cart_items_pk', ['customer_id', 'sku'])
    .addCheckConstraint(
      'saved_cart_items_sku_normalizada',
      sql`sku ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'`,
    )
    // Las mismas invariantes que exige el dominio, tambien en la base: un
    // importe negativo o una cantidad de cero no se pueden ni escribir.
    .addCheckConstraint('saved_cart_items_importe_no_negativo', sql`unit_price_amount >= 0`)
    .addCheckConstraint('saved_cart_items_cantidad_positiva', sql`quantity >= 1`)
    .addCheckConstraint('saved_cart_items_moneda_soportada', sql`currency IN ('COP', 'USD', 'EUR')`)
    .execute()

  // El acceso real es "dame el carrito guardado de este cliente".
  await db.schema
    .createIndex('saved_cart_items_por_cliente')
    .on('saved_cart_items')
    .column('customer_id')
    .execute()
}

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema.dropTable('saved_cart_items').execute()
}
