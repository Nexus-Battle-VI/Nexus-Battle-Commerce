import type { SavedCart } from '../../domain/entities/SavedCart'
import type { CustomerId } from '../../domain/value-objects/commerce-values'

/**
 * Puerto de persistencia del carrito guardado.
 *
 * `findByCustomer` devuelve `null` cuando el cliente nunca guardo nada, igual
 * que la lista de deseos: no hay agregado vacio que devolver, porque un
 * carrito guardado sin lineas no existe.
 *
 * `deleteByCustomer` es necesario porque guardar de nuevo **reemplaza**: el
 * cliente conserva un unico carrito guardado, no un historial. HU-61 no define
 * multiples carritos y no se inventan.
 */
export interface SavedCartRepositoryPort {
  save(cart: SavedCart): Promise<void>
  findByCustomer(customerId: CustomerId): Promise<SavedCart | null>
  deleteByCustomer(customerId: CustomerId): Promise<void>
}

export const SAVED_CART_REPOSITORY = Symbol('SavedCartRepositoryPort')
