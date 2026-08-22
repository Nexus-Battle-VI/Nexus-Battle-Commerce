import type { Order } from '../../domain/entities/Order'
import type { CustomerId, OrderId } from '../../domain/value-objects/commerce-values'

/**
 * Puerto de persistencia del agregado Order.
 *
 * Commerce es propietario exclusivo de sus datos. Ningun otro servicio accede a
 * este almacen, ni directamente ni mediante claves foraneas.
 *
 * El adaptador definitivo sobre PostgreSQL queda sujeto a ADR-005.
 */
export interface OrderRepositoryPort {
  save(order: Order): Promise<void>
  findById(id: OrderId): Promise<Order | null>
  findByCustomer(customerId: CustomerId): Promise<readonly Order[]>
}

export const ORDER_REPOSITORY = Symbol('OrderRepositoryPort')
