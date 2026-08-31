import type { Kysely } from 'kysely'

import { Wishlist } from '../../../domain/entities/Wishlist'
import { Sku } from '../../../domain/value-objects/commerce-values'
import type { CustomerId } from '../../../domain/value-objects/commerce-values'
import type { WishlistRepositoryPort } from '../../../application/ports/WishlistRepositoryPort'
import type { Database } from './schema'

/**
 * Repositorio del agregado Wishlist sobre PostgreSQL, con Kysely.
 *
 * Igual que `PostgresOrderRepository`: el agregado es la autoridad sobre su
 * contenido, asi que `save` reemplaza la lista entera en vez de calcular un
 * diff. Con como mucho unas pocas decenas de referencias por cliente, borrar
 * e insertar es lo mas simple que expresa esa semantica.
 */
export class PostgresWishlistRepository implements WishlistRepositoryPort {
  private readonly db: Kysely<Database>

  constructor(db: Kysely<Database>) {
    this.db = db
  }

  async save(wishlist: Wishlist): Promise<void> {
    const snapshot = wishlist.toSnapshot()

    await this.db.transaction().execute(async (trx) => {
      await trx
        .deleteFrom('wishlist_items')
        .where('customer_id', '=', snapshot.customerId)
        .execute()

      if (snapshot.skus.length === 0) {
        // Una lista vacia es valida (el cliente retiro su ultima referencia):
        // insertar un conjunto vacio seria SQL invalido, asi que se sale antes.
        return
      }

      await trx
        .insertInto('wishlist_items')
        .values(snapshot.skus.map((sku) => ({ customer_id: snapshot.customerId, sku })))
        .execute()
    })
  }

  async findByCustomer(customerId: CustomerId): Promise<Wishlist | null> {
    const rows = await this.db
      .selectFrom('wishlist_items')
      .select('sku')
      .where('customer_id', '=', customerId.value)
      .execute()

    if (rows.length === 0) {
      return null
    }

    return Wishlist.restore({
      customerId,
      skus: rows.map((row) => Sku.create(row.sku)),
    })
  }
}
