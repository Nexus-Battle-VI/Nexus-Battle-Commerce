import { Wishlist } from '../../domain/entities/Wishlist'
import { CustomerId, Sku } from '../../domain/value-objects/commerce-values'
import type { OrderRepositoryPort } from '../ports/OrderRepositoryPort'
import type { WishlistRepositoryPort } from '../ports/WishlistRepositoryPort'
import type { WishlistItemDto } from '../dto/WishlistItemDto'

export interface WishlistDependencies {
  readonly wishlist: WishlistRepositoryPort
  readonly orders: OrderRepositoryPort
}

const loadOrEmpty = async (
  repository: WishlistRepositoryPort,
  customerId: CustomerId,
): Promise<Wishlist> => (await repository.findByCustomer(customerId)) ?? Wishlist.empty(customerId)

/**
 * "Adquirido" no se guarda: se deriva de los pedidos CONFIRMED del cliente en
 * el momento en que se consulta. Guardarlo en la lista de deseos crearia una
 * segunda fuente de verdad que podria divergir de los pedidos reales.
 */
const wasPurchased = async (
  orders: OrderRepositoryPort,
  customerId: CustomerId,
  sku: Sku,
): Promise<boolean> => {
  const found = await orders.findByCustomer(customerId)

  return found.some((order) => order.isConfirmed && order.quantityOf(sku) > 0)
}

/**
 * Anade una referencia a la lista de deseos del cliente.
 *
 * Anadir una referencia ya presente es idempotente: no es un error, la lista
 * simplemente queda como estaba.
 */
export class AddToWishlist {
  private readonly deps: WishlistDependencies

  constructor(deps: WishlistDependencies) {
    this.deps = deps
  }

  async execute(rawCustomerId: string, rawSku: string): Promise<WishlistItemDto> {
    const customerId = CustomerId.create(rawCustomerId)
    const sku = Sku.create(rawSku)

    const wishlist = await loadOrEmpty(this.deps.wishlist, customerId)
    wishlist.add(sku)
    await this.deps.wishlist.save(wishlist)

    return {
      sku: sku.value,
      enDeseos: true,
      adquirido: await wasPurchased(this.deps.orders, customerId, sku),
    }
  }
}

/**
 * Retira una referencia de la lista de deseos del cliente.
 */
export class RemoveFromWishlist {
  private readonly deps: WishlistDependencies

  constructor(deps: WishlistDependencies) {
    this.deps = deps
  }

  async execute(rawCustomerId: string, rawSku: string): Promise<WishlistItemDto> {
    const customerId = CustomerId.create(rawCustomerId)
    const sku = Sku.create(rawSku)

    const wishlist = await loadOrEmpty(this.deps.wishlist, customerId)
    wishlist.remove(sku)
    await this.deps.wishlist.save(wishlist)

    return {
      sku: sku.value,
      enDeseos: false,
      adquirido: await wasPurchased(this.deps.orders, customerId, sku),
    }
  }
}

/**
 * Consulta el estado de una referencia para el cliente: si esta en la lista
 * de deseos y si ya la adquirio.
 */
export class GetWishlistItemStatus {
  private readonly deps: WishlistDependencies

  constructor(deps: WishlistDependencies) {
    this.deps = deps
  }

  async execute(rawCustomerId: string, rawSku: string): Promise<WishlistItemDto> {
    const customerId = CustomerId.create(rawCustomerId)
    const sku = Sku.create(rawSku)

    const wishlist = await loadOrEmpty(this.deps.wishlist, customerId)

    return {
      sku: sku.value,
      enDeseos: wishlist.contains(sku),
      adquirido: await wasPurchased(this.deps.orders, customerId, sku),
    }
  }
}

/**
 * Lista las referencias deseadas del cliente, cada una con su marca de
 * adquirido.
 */
export class ListWishlist {
  private readonly deps: WishlistDependencies

  constructor(deps: WishlistDependencies) {
    this.deps = deps
  }

  async execute(rawCustomerId: string): Promise<readonly WishlistItemDto[]> {
    const customerId = CustomerId.create(rawCustomerId)

    const wishlist = await loadOrEmpty(this.deps.wishlist, customerId)
    const orders = await this.deps.orders.findByCustomer(customerId)

    const purchasedSkus = new Set<string>()
    for (const order of orders) {
      if (!order.isConfirmed) {
        continue
      }

      for (const line of order.toSnapshot().lines) {
        purchasedSkus.add(line.sku)
      }
    }

    return wishlist.toSnapshot().skus.map((sku) => ({
      sku,
      enDeseos: true,
      adquirido: purchasedSkus.has(sku),
    }))
  }
}
