import { SavedCart } from '../../domain/entities/SavedCart'
import { CustomerId, Money, Quantity, Sku } from '../../domain/value-objects/commerce-values'
import { DomainError } from '../../domain/errors/DomainError'
import type { OrderRepositoryPort } from '../ports/OrderRepositoryPort'
import type { SavedCartRepositoryPort } from '../ports/SavedCartRepositoryPort'
import type { IdGeneratorPort } from '../ports/IdGeneratorPort'
import { Order } from '../../domain/entities/Order'
import { OrderId } from '../../domain/value-objects/commerce-values'
import { toOrderDto, type OrderDto } from '../dto/OrderDto'
import type { SavedCartDto } from '../dto/SavedCartDto'
import { toSavedCartDto } from '../dto/SavedCartDto'
import type { ProductPrice, ProductPricingPort } from '../ports/ProductPricingPort'
import { CheckoutConflictError } from '../ports/CommerceIntegrationPorts'
import {
  checkCartQuote,
  currentCart,
  isUniqueConflict,
  productPresentation,
  requirePrice,
} from './OrderUseCases'

export interface SavedCartDependencies {
  readonly savedCarts: SavedCartRepositoryPort
  readonly orders: OrderRepositoryPort
  readonly ids: IdGeneratorPort
  readonly pricing?: ProductPricingPort
}

/** Borrador vigente del cliente, o `null` si no tiene ninguno abierto. */
const draftOf = async (
  orders: OrderRepositoryPort,
  customerId: CustomerId,
): Promise<Order | null> => {
  const found = await orders.findByCustomer(customerId)

  return currentCart(found) ?? null
}

/**
 * Guarda el contenido vigente del carrito para una sesion posterior.
 *
 * Reemplaza lo guardado antes: HU-61 no define historial ni multiples
 * carritos, y conservar varios obligaria a elegir cual recuperar, decision
 * que la historia no describe.
 */
export class SaveCart {
  private readonly deps: SavedCartDependencies

  constructor(deps: SavedCartDependencies) {
    this.deps = deps
  }

  async execute(rawCustomerId: string): Promise<SavedCartDto> {
    const customerId = CustomerId.create(rawCustomerId)
    const draft = await draftOf(this.deps.orders, customerId)

    if (draft === null) {
      throw new DomainError('No hay un carrito abierto que guardar.')
    }
    if (!draft.isEditable)
      throw new CheckoutConflictError(
        'La compra esta en proceso; espera a que termine antes de guardar el carrito.',
      )

    const saved = SavedCart.fromOrder(draft.toSnapshot())

    await this.deps.savedCarts.save(saved)

    return toSavedCartDto(saved.toSnapshot())
  }
}

/**
 * Consulta el carrito guardado del cliente.
 *
 * Devuelve `null` cuando no hay ninguno. La comprobacion de pertenencia es
 * redundante con la consulta por cliente, y esta a proposito: es la unica
 * garantia que sobrevive si algun dia la consulta cambia.
 */
export class GetSavedCart {
  private readonly savedCarts: SavedCartRepositoryPort

  constructor(savedCarts: SavedCartRepositoryPort) {
    this.savedCarts = savedCarts
  }

  async execute(rawCustomerId: string): Promise<SavedCartDto | null> {
    const customerId = CustomerId.create(rawCustomerId)
    const saved = await this.savedCarts.findByCustomer(customerId)

    if (saved?.belongsTo(customerId) !== true) {
      return null
    }

    return toSavedCartDto(saved.toSnapshot())
  }
}

/**
 * Vuelca el carrito guardado sobre el carrito vigente del cliente.
 *
 * **Reemplaza** el contenido del borrador en lugar de fusionarlo. HU-61 pide
 * «recuperar los productos previamente guardados»; fusionar inventaria una
 * regla de precedencia entre dos cantidades de la misma referencia que la
 * historia no define, y que el cliente no podria predecir.
 *
 * Antes de tocar el borrador se valida el lote completo contra Catalog. Un
 * precio distinto requiere una nueva aceptacion; nunca se sustituye en silencio.
 */
export class RestoreSavedCart {
  private readonly deps: SavedCartDependencies

  constructor(deps: SavedCartDependencies) {
    this.deps = deps
  }

  async execute(rawCustomerId: string): Promise<OrderDto> {
    const customerId = CustomerId.create(rawCustomerId)
    const saved = await this.deps.savedCarts.findByCustomer(customerId)

    if (saved?.belongsTo(customerId) !== true) {
      throw new DomainError('Este cliente no tiene ningun carrito guardado.')
    }

    const existing = await draftOf(this.deps.orders, customerId)
    if (existing !== null && !existing.isEditable)
      throw new CheckoutConflictError(
        'La compra esta en proceso; no se puede reemplazar su carrito.',
      )
    const prepared = new Map<string, { price: ProductPrice; quantity: number }>()
    for (const item of saved.lines) {
      const price =
        this.deps.pricing === undefined
          ? {
              ...item,
              sku: item.catalogSku ?? item.sku.value,
              amount: item.unitPrice.amount,
              currency: saved.currency,
            }
          : await requirePrice(this.deps.pricing, item.productId ?? item.sku.value)
      const key = price.productId ?? price.sku
      const previous = prepared.get(key)
      const quantity = (previous?.quantity ?? 0) + item.quantity.value
      checkCartQuote(price, quantity, saved.currency, item.unitPrice.amount)
      if (previous !== undefined)
        checkCartQuote(price, quantity, saved.currency, previous.price.amount)
      prepared.set(key, { price, quantity })
    }
    const fill = (target: Order): Order => {
      if (!target.isEditable)
        throw new CheckoutConflictError(
          'La compra esta en proceso; no se puede reemplazar su carrito.',
        )
      for (const line of target.toSnapshot().lines) target.removeLine(Sku.create(line.sku))
      target.changeCurrency(saved.currency)
      for (const [reference, item] of prepared)
        target.addLine(
          Sku.create(reference),
          Money.create(item.price.amount, saved.currency),
          Quantity.create(item.quantity),
          productPresentation(item.price),
        )
      return target
    }
    let target = fill(
      existing ??
        Order.draft({
          id: OrderId.create(this.deps.ids.generate()),
          customerId,
          currency: saved.currency,
        }),
    )
    try {
      await this.deps.orders.save(target)
    } catch (error: unknown) {
      if (existing !== null || !isUniqueConflict(error)) throw error
      const winner = await draftOf(this.deps.orders, customerId)
      if (winner === null) throw error
      target = fill(winner)
      await this.deps.orders.save(target)
    }
    return toOrderDto(target.toSnapshot())
  }
}

/** Descarta el carrito guardado. */
export class DiscardSavedCart {
  private readonly savedCarts: SavedCartRepositoryPort

  constructor(savedCarts: SavedCartRepositoryPort) {
    this.savedCarts = savedCarts
  }

  async execute(rawCustomerId: string): Promise<void> {
    await this.savedCarts.deleteByCustomer(CustomerId.create(rawCustomerId))
  }
}
