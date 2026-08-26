import type { Order } from '../../domain/entities/Order'
import type { CustomerId, OrderId } from '../../domain/value-objects/commerce-values'

/**
 * Puerto de persistencia del agregado Order.
 *
 * Commerce es propietario exclusivo de sus datos. Ningun otro servicio accede a
 * este almacen, ni directamente ni mediante claves foraneas.
 *
 * Hay dos adaptadores, y `PERSISTENCE_DRIVER` elige cual opera:
 * `PostgresOrderRepository` sobre PostgreSQL (ADR-012) y el de memoria.
 *
 * El de memoria NO es un resto del andamiaje: es el que permite que las pruebas
 * del dominio y de los casos de uso corran sin Docker. Ambos cumplen el mismo
 * contrato, incluido el de no filtrar al almacen una mutacion sin guardar.
 */
export interface OrderRepositoryPort {
  save(order: Order): Promise<void>
  findById(id: OrderId): Promise<Order | null>
  findByCustomer(customerId: CustomerId): Promise<readonly Order[]>
}

export const ORDER_REPOSITORY = Symbol('OrderRepositoryPort')
