import { DomainError } from '../errors/DomainError'
import type { CustomerId, Sku } from '../value-objects/commerce-values'

export interface WishlistSnapshot {
  readonly customerId: string
  readonly skus: readonly string[]
}

/**
 * Raiz de agregado de la lista de deseos.
 *
 * Una lista por cliente. Guarda unicamente referencias: no conoce el nombre,
 * la descripcion ni el precio del producto, que viven en Catalog. Si una
 * referencia deja de existir en el catalogo, la lista sigue siendo valida;
 * es la interfaz quien decide como mostrar una referencia que ya no resuelve.
 */
export class Wishlist {
  readonly customerId: CustomerId
  private readonly skus: Set<string>

  private constructor(customerId: CustomerId, skus: Set<string>) {
    this.customerId = customerId
    this.skus = skus
  }

  /** Lista vacia para un cliente que todavia no ha deseado nada. */
  static empty(customerId: CustomerId): Wishlist {
    return new Wishlist(customerId, new Set())
  }

  /** Reconstituye una lista persistida. */
  static restore(params: { customerId: CustomerId; skus: readonly Sku[] }): Wishlist {
    return new Wishlist(params.customerId, new Set(params.skus.map((sku) => sku.value)))
  }

  contains(sku: Sku): boolean {
    return this.skus.has(sku.value)
  }

  get size(): number {
    return this.skus.size
  }

  /** Anadir una referencia ya presente no falla: queda como estaba. */
  add(sku: Sku): void {
    this.skus.add(sku.value)
  }

  remove(sku: Sku): void {
    if (!this.skus.has(sku.value)) {
      throw new DomainError(
        `La referencia "${sku.value}" no esta en la lista de deseos de "${this.customerId.value}".`,
      )
    }

    this.skus.delete(sku.value)
  }

  toSnapshot(): WishlistSnapshot {
    return {
      customerId: this.customerId.value,
      skus: [...this.skus].sort(),
    }
  }
}
