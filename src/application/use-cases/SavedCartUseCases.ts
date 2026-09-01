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

export interface SavedCartDependencies {
  readonly savedCarts: SavedCartRepositoryPort
  readonly orders: OrderRepositoryPort
  readonly ids: IdGeneratorPort
}

/** Borrador vigente del cliente, o `null` si no tiene ninguno abierto. */
const draftOf = async (
  orders: OrderRepositoryPort,
  customerId: CustomerId,
): Promise<Order | null> => {
  const found = await orders.findByCustomer(customerId)

  return found.find((order) => order.isEditable) ?? null
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
 * Los precios que se restauran son los guardados, no los vigentes: es lo que
 * el cliente vio cuando decidio conservar el carrito.
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
    const target =
      existing ??
      Order.draft({
        id: OrderId.create(this.deps.ids.generate()),
        customerId,
        currency: saved.currency,
      })

    // Se vacia antes de volcar: restaurar deja el carrito como se guardo, no
    // como se guardo mas lo que hubiera suelto en esta sesion.
    for (const line of target.toSnapshot().lines) {
      target.removeLine(Sku.create(line.sku))
    }

    for (const item of saved.lines) {
      target.addLine(
        item.sku,
        Money.create(item.unitPrice.amount, saved.currency),
        Quantity.create(item.quantity.value),
      )
    }

    await this.deps.orders.save(target)

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
