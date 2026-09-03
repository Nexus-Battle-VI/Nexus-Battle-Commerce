import { Wishlist } from '../../domain/entities/Wishlist'
import { CustomerId, Sku } from '../../domain/value-objects/commerce-values'
import type { OrderRepositoryPort } from '../ports/OrderRepositoryPort'
import type { WishlistRepositoryPort } from '../ports/WishlistRepositoryPort'
import type { ProductPricingPort } from '../ports/ProductPricingPort'
import type { PurchaseStorePort } from '../ports/CommerceIntegrationPorts'
import { ProductNotPurchasableError } from '../errors/ApplicationError'
import { DomainError } from '../../domain/errors/DomainError'
import type { WishlistItemDto } from '../dto/WishlistItemDto'

export interface WishlistDependencies {
  readonly wishlist: WishlistRepositoryPort
  readonly orders: OrderRepositoryPort
  readonly pricing?: ProductPricingPort
  readonly purchases?: Pick<PurchaseStorePort, 'wasPurchased'>
}
interface Reference {
  readonly key: string
  readonly sku: string
  readonly productId?: string
  readonly aliases: readonly string[]
}
const loadOrEmpty = async (
  repository: WishlistRepositoryPort,
  customerId: CustomerId,
): Promise<Wishlist> => (await repository.findByCustomer(customerId)) ?? Wishlist.empty(customerId)

const resolve = async (
  deps: WishlistDependencies,
  raw: string,
  adding = false,
): Promise<Reference> => {
  const reference = Sku.create(raw).value
  const product = await deps.pricing?.productOf?.(reference)
  if (
    adding &&
    deps.pricing?.productOf !== undefined &&
    (product === null || product?.lifecycleStatus !== 'ACTIVE')
  ) {
    throw new ProductNotPurchasableError(reference)
  }
  if (product === null || product === undefined)
    return { key: reference, sku: reference, aliases: [reference] }
  const productId = Sku.create(product.productId).value
  const sku = Sku.create(product.sku).value
  return { key: productId, productId, sku, aliases: [...new Set([reference, productId, sku])] }
}

/** Produccion deriva adquirido solo de compras completadas; el fallback es para adaptadores locales. */
const wasPurchased = async (
  deps: WishlistDependencies,
  customer: CustomerId,
  reference: Reference,
): Promise<boolean> => {
  if (deps.purchases !== undefined)
    return deps.purchases.wasPurchased(customer.value, reference.key)
  return (await deps.orders.findByCustomer(customer)).some(
    (order) =>
      order.isConfirmed &&
      order
        .toSnapshot()
        .lines.some((line) =>
          [line.sku, line.productId, line.catalogSku].some(
            (value) => value !== undefined && reference.aliases.includes(value),
          ),
        ),
  )
}
const dto = async (
  deps: WishlistDependencies,
  customer: CustomerId,
  reference: Reference,
  desired: boolean,
): Promise<WishlistItemDto> => ({
  ...(reference.productId === undefined ? {} : { productId: reference.productId }),
  sku: reference.sku,
  enDeseos: desired,
  adquirido: await wasPurchased(deps, customer, reference),
})
const contains = (wishlist: Wishlist, reference: Reference): boolean =>
  reference.aliases.some((alias) => wishlist.contains(Sku.create(alias)))

/** Cada referencia se actualiza atomicamente sin sobrescribir deseos concurrentes de otros productos. */
const setDesired = async (
  deps: WishlistDependencies,
  customer: CustomerId,
  wishlist: Wishlist,
  reference: Reference,
  desired: boolean,
): Promise<void> => {
  if (deps.wishlist.setDesired !== undefined) {
    await deps.wishlist.setDesired(customer, Sku.create(reference.key), desired)
    for (const alias of reference.aliases.filter(
      (value) => value !== reference.key && wishlist.contains(Sku.create(value)),
    )) {
      await deps.wishlist.setDesired(customer, Sku.create(alias), false)
    }
    return
  }
  for (const alias of reference.aliases) {
    const sku = Sku.create(alias)
    if (wishlist.contains(sku)) wishlist.remove(sku)
  }
  if (desired) wishlist.add(Sku.create(reference.key))
  await deps.wishlist.save(wishlist)
}

export class AddToWishlist {
  constructor(private readonly deps: WishlistDependencies) {}
  async execute(rawCustomerId: string, rawReference: string): Promise<WishlistItemDto> {
    const customer = CustomerId.create(rawCustomerId)
    const reference = await resolve(this.deps, rawReference, true)
    const wishlist = await loadOrEmpty(this.deps.wishlist, customer)
    await setDesired(this.deps, customer, wishlist, reference, true)
    return dto(this.deps, customer, reference, true)
  }
}
export class RemoveFromWishlist {
  constructor(private readonly deps: WishlistDependencies) {}
  async execute(rawCustomerId: string, rawReference: string): Promise<WishlistItemDto> {
    const customer = CustomerId.create(rawCustomerId)
    const reference = await resolve(this.deps, rawReference)
    const wishlist = await loadOrEmpty(this.deps.wishlist, customer)
    if (!contains(wishlist, reference))
      throw new DomainError('La referencia no esta en la lista de deseos.')
    await setDesired(this.deps, customer, wishlist, reference, false)
    return dto(this.deps, customer, reference, false)
  }
}
export class GetWishlistItemStatus {
  constructor(private readonly deps: WishlistDependencies) {}
  async execute(rawCustomerId: string, rawReference: string): Promise<WishlistItemDto> {
    const customer = CustomerId.create(rawCustomerId)
    const reference = await resolve(this.deps, rawReference)
    const wishlist = await loadOrEmpty(this.deps.wishlist, customer)
    return dto(this.deps, customer, reference, contains(wishlist, reference))
  }
}
export class ListWishlist {
  constructor(private readonly deps: WishlistDependencies) {}
  async execute(rawCustomerId: string): Promise<readonly WishlistItemDto[]> {
    const customer = CustomerId.create(rawCustomerId)
    const wishlist = await loadOrEmpty(this.deps.wishlist, customer)
    const references = await Promise.all(
      wishlist.toSnapshot().skus.map((sku) => resolve(this.deps, sku)),
    )
    const unique = [...new Map(references.map((reference) => [reference.key, reference])).values()]
    return Promise.all(unique.map((reference) => dto(this.deps, customer, reference, true)))
  }
}
