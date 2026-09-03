import { CheckoutConflictError } from '../../../application/ports/CommerceIntegrationPorts'
import { Order } from '../../../domain/entities/Order'
import type { OrderSnapshot } from '../../../domain/entities/Order'
import {
  CustomerId,
  Money,
  OrderId,
  Quantity,
  Sku,
} from '../../../domain/value-objects/commerce-values'
import type { OrderRepositoryPort } from '../../../application/ports/OrderRepositoryPort'

/**
 * Repositorio en memoria del agregado Order.
 *
 * Almacena instantaneas, no referencias al agregado, de modo que una mutacion
 * no persistida nunca se filtra al almacen. Con referencias vivas, una prueba
 * pasaria aunque el caso de uso olvidara guardar.
 *
 * El adaptador definitivo sobre PostgreSQL queda sujeto a ADR-005.
 */
export class InMemoryOrderRepository implements OrderRepositoryPort {
  private readonly byId = new Map<string, OrderSnapshot>()

  save(order: Order): Promise<void> {
    if (
      ['DRAFT', 'PROCESSING'].includes(order.currentStatus) &&
      [...this.byId.values()].some(
        (snapshot) =>
          snapshot.id !== order.id.value &&
          snapshot.customerId === order.customerId.value &&
          ['DRAFT', 'PROCESSING'].includes(snapshot.status),
      )
    ) {
      return Promise.reject(
        Object.assign(
          new CheckoutConflictError('Ya existe un carrito vigente para este cliente.'),
          { code: '23505', constraint: 'orders_one_live_cart' },
        ),
      )
    }
    const existing = this.byId.get(order.id.value)
    if ((existing?.version ?? 0) !== order.persistenceVersion) {
      throw new CheckoutConflictError('El carrito cambio en otra solicitud; vuelve a consultarlo.')
    }
    order.markPersisted()
    this.byId.set(order.id.value, order.toSnapshot())

    return Promise.resolve()
  }

  findById(id: OrderId): Promise<Order | null> {
    const snapshot = this.byId.get(id.value)

    return Promise.resolve(
      snapshot === undefined ? null : InMemoryOrderRepository.hydrate(snapshot),
    )
  }

  findByCustomer(customerId: CustomerId): Promise<readonly Order[]> {
    const found = [...this.byId.values()]
      .filter((snapshot) => snapshot.customerId === customerId.value)
      .map((snapshot) => InMemoryOrderRepository.hydrate(snapshot))
      .sort((a, b) => a.id.value.localeCompare(b.id.value))

    return Promise.resolve(found)
  }

  get size(): number {
    return this.byId.size
  }

  clear(): void {
    this.byId.clear()
  }

  private static hydrate(snapshot: OrderSnapshot): Order {
    return Order.restore({
      id: OrderId.create(snapshot.id),
      customerId: CustomerId.create(snapshot.customerId),
      currency: snapshot.currency,
      status: snapshot.status,
      version: snapshot.version ?? 0,
      lines: snapshot.lines.map((line) => ({
        ...line,
        sku: Sku.create(line.sku),
        unitPrice: Money.create(line.unitPriceAmount, snapshot.currency),
        quantity: Quantity.create(line.quantity),
      })),
    })
  }
}
