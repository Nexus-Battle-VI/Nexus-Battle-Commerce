import { Wishlist } from '../../../domain/entities/Wishlist'
import type { WishlistSnapshot } from '../../../domain/entities/Wishlist'
import { CustomerId, Sku } from '../../../domain/value-objects/commerce-values'
import type { WishlistRepositoryPort } from '../../../application/ports/WishlistRepositoryPort'

/**
 * Repositorio en memoria del agregado Wishlist.
 *
 * Almacena instantaneas, no referencias al agregado, por la misma razon que
 * `InMemoryOrderRepository`: una mutacion no persistida no debe filtrarse al
 * almacen.
 */
export class InMemoryWishlistRepository implements WishlistRepositoryPort {
  private readonly byCustomer = new Map<string, WishlistSnapshot>()

  save(wishlist: Wishlist): Promise<void> {
    this.byCustomer.set(wishlist.customerId.value, wishlist.toSnapshot())

    return Promise.resolve()
  }

  findByCustomer(customerId: CustomerId): Promise<Wishlist | null> {
    const snapshot = this.byCustomer.get(customerId.value)

    return Promise.resolve(
      snapshot === undefined ? null : InMemoryWishlistRepository.hydrate(snapshot),
    )
  }

  get size(): number {
    return this.byCustomer.size
  }

  clear(): void {
    this.byCustomer.clear()
  }

  private static hydrate(snapshot: WishlistSnapshot): Wishlist {
    return Wishlist.restore({
      customerId: CustomerId.create(snapshot.customerId),
      skus: snapshot.skus.map((sku) => Sku.create(sku)),
    })
  }
}
