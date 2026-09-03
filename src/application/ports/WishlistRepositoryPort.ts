import type { Wishlist } from '../../domain/entities/Wishlist'
import type { CustomerId, Sku } from '../../domain/value-objects/commerce-values'

/**
 * Puerto de persistencia del agregado Wishlist.
 *
 * `findByCustomer` devuelve `null` cuando el cliente nunca ha deseado nada,
 * no un agregado vacio: no hay un paso de creacion explicito equivalente a
 * `CreateOrder`, la lista nace en el primer `add`.
 */
export interface WishlistRepositoryPort {
  setDesired?(customerId: CustomerId, sku: Sku, desired: boolean): Promise<void>
  save(wishlist: Wishlist): Promise<void>
  findByCustomer(customerId: CustomerId): Promise<Wishlist | null>
}

export const WISHLIST_REPOSITORY = Symbol('WishlistRepositoryPort')
