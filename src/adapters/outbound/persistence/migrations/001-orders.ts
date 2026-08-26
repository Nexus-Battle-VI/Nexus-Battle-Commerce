import { sql, type Kysely } from 'kysely'

/**
 * Esquema inicial de Commerce.
 *
 * Las migraciones son TypeScript revisable en un PR, que es una de las razones
 * por las que ADR-012 eligio Kysely: el esquema cambia por el mismo camino que
 * el codigo, no por un fichero generado que nadie lee.
 *
 * `up` y `down` reciben `Kysely<unknown>` a proposito: una migracion NO debe
 * tipar contra el esquema actual. Si lo hiciera, dejaria de compilar en cuanto
 * una migracion posterior cambiara una tabla, y una migracion antigua tiene que
 * seguir siendo ejecutable tal y como se escribio.
 */
export const up = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema
    .createTable('orders')
    .addColumn('id', 'text', (col) => col.primaryKey())
    // Sin clave foranea a proposito: el cliente vive en Account, y una clave
    // foranea entre servicios esta prohibida en este proyecto.
    .addColumn('customer_id', 'text', (col) => col.notNull())
    .addColumn('status', 'text', (col) => col.notNull())
    // La moneda vive aqui y no en cada linea: el dominio exige que todas las
    // lineas compartan la del pedido, y con una sola columna esa divergencia no
    // se puede ni representar.
    .addColumn('currency', 'text', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addCheckConstraint(
      'orders_estado_conocido',
      sql`status in ('DRAFT', 'CONFIRMED', 'CANCELLED')`,
    )
    .addCheckConstraint('orders_moneda_conocida', sql`currency in ('COP', 'USD', 'EUR')`)
    .execute()

  // El acceso real es "dame los pedidos de este cliente". Sin este indice, cada
  // consulta recorreria la tabla entera de pedidos.
  await db.schema.createIndex('orders_por_cliente').on('orders').column('customer_id').execute()

  await db.schema
    .createTable('order_lines')
    .addColumn('order_id', 'text', (col) =>
      // Clave foranea DENTRO del mismo servicio. La prohibicion del proyecto es
      // sobre claves foraneas entre servicios.
      col.notNull().references('orders.id').onDelete('cascade'),
    )
    .addColumn('sku', 'text', (col) => col.notNull())
    // `bigint` y no `integer`: un pedido en COP supera los 2.147.483.647 sin
    // ninguna dificultad, y desbordar un importe es la clase de error que nadie
    // detecta hasta que cuadra la caja.
    .addColumn('unit_price_amount', 'bigint', (col) => col.notNull())
    .addColumn('quantity', 'integer', (col) => col.notNull())
    // La clave primaria es (pedido, referencia): es lo que impide que un pedido
    // repita una referencia, que es exactamente lo que `Order.restore` rechaza.
    // La invariante queda en el motor y no solo en el codigo.
    .addPrimaryKeyConstraint('order_lines_pk', ['order_id', 'sku'])
    .addCheckConstraint('order_lines_importe_no_negativo', sql`unit_price_amount >= 0`)
    // La referencia se guarda normalizada, con la MISMA forma que exige `Sku`.
    // Sin esto, la clave primaria solo impediria repetir la cadena exacta: el
    // motor aceptaria `SKU-A` y `sku-a` como dos referencias distintas del
    // mismo pedido, y la invariante que la clave debia garantizar se esquivaria
    // escribiendo con otra caja.
    .addCheckConstraint('order_lines_sku_normalizada', sql`sku ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'`)
    // Los limites de cantidad son del dominio (`Quantity`). Se repiten aqui
    // porque una migracion no puede importarlo; hay una prueba que compara
    // ambos y falla si divergen.
    .addCheckConstraint('order_lines_cantidad_en_rango', sql`quantity >= 1 and quantity <= 999`)
    .execute()
}

export const down = async (db: Kysely<unknown>): Promise<void> => {
  // En orden inverso: `order_lines` referencia a `orders`.
  await db.schema.dropTable('order_lines').execute()
  await db.schema.dropTable('orders').execute()
}
