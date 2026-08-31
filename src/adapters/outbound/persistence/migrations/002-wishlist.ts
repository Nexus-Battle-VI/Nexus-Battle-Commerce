import { sql, type Kysely } from 'kysely'

/**
 * Lista de deseos de HU-56.
 *
 * Sin clave foranea hacia `orders`: "adquirido" se calcula leyendo `orders`
 * en el momento de la consulta, esta tabla no lo persiste.
 */
export const up = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema
    .createTable('wishlist_items')
    // Sin clave foranea a proposito: el cliente vive en Account.
    .addColumn('customer_id', 'text', (col) => col.notNull())
    .addColumn('sku', 'text', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    // La clave primaria es (cliente, referencia): impide que la misma
    // referencia aparezca dos veces en la lista de un cliente, que es
    // exactamente la invariante de `Wishlist.add`.
    .addPrimaryKeyConstraint('wishlist_items_pk', ['customer_id', 'sku'])
    // La misma forma que exige `Sku`, y por la misma razon que en
    // `order_lines`: sin esto, `SKU-A` y `sku-a` conviven como referencias
    // distintas de la misma lista.
    .addCheckConstraint(
      'wishlist_items_sku_normalizada',
      sql`sku ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'`,
    )
    .execute()

  // El acceso real es "dame la lista de este cliente".
  await db.schema
    .createIndex('wishlist_items_por_cliente')
    .on('wishlist_items')
    .column('customer_id')
    .execute()
}

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema.dropTable('wishlist_items').execute()
}
