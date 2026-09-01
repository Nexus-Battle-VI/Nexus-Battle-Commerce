import { DomainError } from '../errors/DomainError'
import { CustomerId, Money, Quantity, Sku } from '../value-objects/commerce-values'

export interface SavedCartItemSnapshot {
  readonly sku: string
  readonly unitPriceAmount: number
  readonly quantity: number
}

export interface SavedCartSnapshot {
  readonly customerId: string
  readonly currency: string
  readonly items: readonly SavedCartItemSnapshot[]
}

interface SavedCartItem {
  readonly sku: Sku
  readonly unitPrice: Money
  readonly quantity: Quantity
}

/**
 * Carrito que un cliente guardo para retomarlo en una sesion posterior.
 *
 * Es un agregado **distinto de `Order`**, y esa separacion es el nucleo de
 * HU-61. El pedido en borrador es el carrito vivo de la sesion en curso;
 * este es una copia congelada que el cliente pidio conservar de forma
 * explicita. Fundirlos obligaria a decidir, en cada lectura del borrador, si
 * el cliente queria conservarlo o solo lo estaba usando, y esa pregunta no
 * tiene respuesta observable.
 *
 * Guarda el precio unitario junto a cada referencia por la misma razon que
 * `Order`: lo que se recupera es lo que se guardo, no lo que el catalogo
 * cueste el dia que se vuelva.
 *
 * La identidad es obligatoria y verificada: un carrito guardado sin saber de
 * quien es no se puede devolver a nadie. Quien decide si la identidad esta
 * verificada es el adaptador de entrada, que es el unico que lo sabe.
 */
export class SavedCart {
  private readonly customerId: CustomerId
  private readonly currencyCode: string
  private readonly items: SavedCartItem[]

  private constructor(customerId: CustomerId, currency: string, items: SavedCartItem[]) {
    this.customerId = customerId
    this.currencyCode = currency
    this.items = items
  }

  /**
   * Congela el contenido de un carrito vigente.
   *
   * Acepta la instantanea del pedido y no el agregado: guardar es una lectura
   * del carrito, y recibir el `Order` completo permitiria modificarlo desde
   * aqui sin que nada lo impida.
   */
  static fromOrder(snapshot: {
    readonly customerId: string
    readonly currency: string
    readonly lines: readonly {
      readonly sku: string
      readonly unitPriceAmount: number
      readonly quantity: number
    }[]
  }): SavedCart {
    if (snapshot.lines.length === 0) {
      throw new DomainError('No se puede guardar un carrito sin lineas.')
    }

    return new SavedCart(
      CustomerId.create(snapshot.customerId),
      Money.zero(snapshot.currency).currency,
      snapshot.lines.map((line) => ({
        sku: Sku.create(line.sku),
        unitPrice: Money.create(line.unitPriceAmount, snapshot.currency),
        quantity: Quantity.create(line.quantity),
      })),
    )
  }

  /** Reconstituye lo persistido. No valida de menos: revalida todo. */
  static restore(snapshot: SavedCartSnapshot): SavedCart {
    if (snapshot.items.length === 0) {
      throw new DomainError('Un carrito guardado sin lineas no deberia existir.')
    }

    return new SavedCart(
      CustomerId.create(snapshot.customerId),
      Money.zero(snapshot.currency).currency,
      snapshot.items.map((item) => ({
        sku: Sku.create(item.sku),
        unitPrice: Money.create(item.unitPriceAmount, snapshot.currency),
        quantity: Quantity.create(item.quantity),
      })),
    )
  }

  get owner(): CustomerId {
    return this.customerId
  }

  get currency(): string {
    return this.currencyCode
  }

  get size(): number {
    return this.items.length
  }

  /**
   * Comprueba que este carrito pertenece a quien lo pide.
   *
   * CA-02 de HU-61: el carrito de A jamas se presenta como carrito de B. La
   * comprobacion vive en el agregado y no solo en la consulta, de modo que
   * ninguna ruta nueva pueda saltarsela por descuido.
   */
  belongsTo(customerId: CustomerId): boolean {
    return this.customerId.equals(customerId)
  }

  /** Contenido guardado, para volcarlo sobre un pedido en borrador. */
  get lines(): readonly SavedCartItem[] {
    return [...this.items]
  }

  toSnapshot(): SavedCartSnapshot {
    return {
      customerId: this.customerId.value,
      currency: this.currencyCode,
      items: this.items.map((item) => ({
        sku: item.sku.value,
        unitPriceAmount: item.unitPrice.amount,
        quantity: item.quantity.value,
      })),
    }
  }
}
