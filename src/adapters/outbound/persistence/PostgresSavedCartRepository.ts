import type { Kysely } from 'kysely'

import { SavedCart } from '../../../domain/entities/SavedCart'
import type { CustomerId } from '../../../domain/value-objects/commerce-values'
import type { SavedCartRepositoryPort } from '../../../application/ports/SavedCartRepositoryPort'
import { toExactAmount } from './mapping'
import type { Database } from './schema'

/**
 * Carrito guardado sobre PostgreSQL.
 *
 * Reemplaza el contenido completo en cada `save`, igual que los otros dos
 * repositorios: el agregado es la autoridad sobre lo que contiene, y calcular
 * un diff sobre una decena de lineas solo anadiria formas de equivocarse.
 *
 * La moneda vive en cada fila y no en una tabla aparte porque un carrito
 * guardado no tiene mas estado que sus lineas; `SavedCart.restore` exige que
 * todas compartan moneda, asi que una divergencia se detecta al leer.
 */
export class PostgresSavedCartRepository implements SavedCartRepositoryPort {
  private readonly db: Kysely<Database>

  constructor(db: Kysely<Database>) {
    this.db = db
  }

  async save(cart: SavedCart): Promise<void> {
    const snapshot = cart.toSnapshot()

    await this.db.transaction().execute(async (trx) => {
      await trx
        .deleteFrom('saved_cart_items')
        .where('customer_id', '=', snapshot.customerId)
        .execute()

      await trx
        .insertInto('saved_cart_items')
        .values(
          snapshot.items.map((item) => ({
            customer_id: snapshot.customerId,
            sku: item.sku,
            currency: snapshot.currency,
            unit_price_amount: String(item.unitPriceAmount),
            quantity: item.quantity,
          })),
        )
        .execute()
    })
  }

  async findByCustomer(customerId: CustomerId): Promise<SavedCart | null> {
    const rows = await this.db
      .selectFrom('saved_cart_items')
      .select(['sku', 'currency', 'unit_price_amount', 'quantity'])
      .where('customer_id', '=', customerId.value)
      .execute()

    if (rows.length === 0) {
      return null
    }

    const [first] = rows

    if (first === undefined) {
      return null
    }

    return SavedCart.restore({
      customerId: customerId.value,
      currency: first.currency,
      items: rows.map((row) => ({
        sku: row.sku,
        // `bigint` llega como cadena: se comprueba que siga siendo exacto en
        // JavaScript antes de devolverlo, igual que en las lineas del pedido.
        unitPriceAmount: toExactAmount(
          row.unit_price_amount,
          `El carrito guardado de ${customerId.value}`,
        ),
        quantity: row.quantity,
      })),
    })
  }

  async deleteByCustomer(customerId: CustomerId): Promise<void> {
    await this.db
      .deleteFrom('saved_cart_items')
      .where('customer_id', '=', customerId.value)
      .execute()
  }
}
