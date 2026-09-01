import type { SavedCartRepositoryPort } from '../../../application/ports/SavedCartRepositoryPort'
import { SavedCart } from '../../../domain/entities/SavedCart'
import type { CustomerId } from '../../../domain/value-objects/commerce-values'

/**
 * Carritos guardados en memoria.
 *
 * Guarda instantaneas y no referencias vivas, igual que el resto de
 * repositorios en memoria: si conservara el agregado, cualquier cambio
 * posterior sobre el objeto que tiene quien lo guardo se veria reflejado aqui
 * sin haber llamado a `save`, que es justo lo que un almacen no debe permitir.
 */
export class InMemorySavedCartRepository implements SavedCartRepositoryPort {
  private readonly carts = new Map<string, ReturnType<SavedCart['toSnapshot']>>()

  save(cart: SavedCart): Promise<void> {
    this.carts.set(cart.owner.value, cart.toSnapshot())

    return Promise.resolve()
  }

  findByCustomer(customerId: CustomerId): Promise<SavedCart | null> {
    const snapshot = this.carts.get(customerId.value)

    return Promise.resolve(snapshot === undefined ? null : SavedCart.restore(snapshot))
  }

  deleteByCustomer(customerId: CustomerId): Promise<void> {
    this.carts.delete(customerId.value)

    return Promise.resolve()
  }

  get size(): number {
    return this.carts.size
  }
}
