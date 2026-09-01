import { DomainError } from '../errors/DomainError'
import type { DomainEvent } from '../events/DomainEvent'
import { orderCancelled, orderConfirmed } from '../events/OrderEvents'
import { Money } from '../value-objects/commerce-values'
import type { CustomerId, OrderId, Quantity, Sku } from '../value-objects/commerce-values'

/**
 * Ciclo de vida de un pedido.
 *
 * `Draft` es el carrito: admite cambios. `Confirmed` es un compromiso: ya no
 * admite ninguno. `Cancelled` es terminal.
 */
export const OrderStatus = {
  Draft: 'DRAFT',
  Confirmed: 'CONFIRMED',
  Cancelled: 'CANCELLED',
} as const

export type OrderStatus = (typeof OrderStatus)[keyof typeof OrderStatus]

export interface OrderLineSnapshot {
  readonly sku: string
  readonly unitPriceAmount: number
  readonly quantity: number
  readonly subtotalAmount: number
}

export interface OrderSnapshot {
  readonly id: string
  readonly customerId: string
  readonly status: OrderStatus
  readonly currency: string
  readonly totalAmount: number
  /** Suma de las cantidades. Derivado, como el total: no se persiste. */
  readonly itemCount: number
  readonly lines: readonly OrderLineSnapshot[]
}

interface OrderLine {
  readonly sku: Sku
  readonly unitPrice: Money
  quantity: Quantity
}

/**
 * Raiz de agregado del contexto Commerce.
 *
 * Un pedido conserva el **precio acordado en el momento de anadir la linea**,
 * no una referencia viva al catalogo. Es la decision central del contexto: si
 * el precio se consultara al confirmar, un cambio en Catalog alteraria de forma
 * retroactiva lo que la persona vio al comprar.
 */
export class Order {
  readonly id: OrderId
  readonly customerId: CustomerId
  readonly currency: string
  private status: OrderStatus
  private readonly lines: OrderLine[]
  private readonly events: DomainEvent[] = []

  private constructor(params: {
    id: OrderId
    customerId: CustomerId
    currency: string
    status: OrderStatus
    lines: OrderLine[]
  }) {
    this.id = params.id
    this.customerId = params.customerId
    this.currency = params.currency
    this.status = params.status
    this.lines = params.lines
  }

  /** Abre un pedido vacio en borrador. */
  static draft(params: { id: OrderId; customerId: CustomerId; currency: string }): Order {
    return new Order({
      id: params.id,
      customerId: params.customerId,
      currency: params.currency,
      status: OrderStatus.Draft,
      lines: [],
    })
  }

  /** Reconstituye un pedido persistido. No emite eventos. */
  static restore(params: {
    id: OrderId
    customerId: CustomerId
    currency: string
    status: OrderStatus
    lines: readonly { sku: Sku; unitPrice: Money; quantity: Quantity }[]
  }): Order {
    const lines: OrderLine[] = []

    for (const line of params.lines) {
      if (line.unitPrice.currency !== params.currency) {
        throw new DomainError(
          `La linea ${line.sku.value} esta en ${line.unitPrice.currency} y el pedido en ${params.currency}.`,
        )
      }

      if (lines.some((existing) => existing.sku.equals(line.sku))) {
        throw new DomainError(`El pedido restaurado repite la referencia "${line.sku.value}".`)
      }

      lines.push({ sku: line.sku, unitPrice: line.unitPrice, quantity: line.quantity })
    }

    return new Order({
      id: params.id,
      customerId: params.customerId,
      currency: params.currency,
      status: params.status,
      lines,
    })
  }

  get currentStatus(): OrderStatus {
    return this.status
  }

  get isEditable(): boolean {
    return this.status === OrderStatus.Draft
  }

  get isConfirmed(): boolean {
    return this.status === OrderStatus.Confirmed
  }

  get lineCount(): number {
    return this.lines.length
  }

  /**
   * Numero de unidades del pedido: suma de las cantidades de sus lineas.
   *
   * Es lo que la vista minimizada del carrito muestra junto al icono. Se
   * distingue de `lineCount`, que cuenta referencias distintas: dos unidades de
   * una misma espada son un `lineCount` de 1 y un `itemCount` de 2.
   */
  get itemCount(): number {
    return this.lines.reduce((total, line) => total + line.quantity.value, 0)
  }

  get isEmpty(): boolean {
    return this.lines.length === 0
  }

  /**
   * Total del pedido: suma de los subtotales de sus lineas.
   *
   * Se calcula, no se almacena. Un total almacenado puede quedar desincronizado
   * de las lineas que lo justifican, y esa divergencia es invisible hasta que
   * alguien la reclama.
   */
  get total(): Money {
    return this.lines.reduce<Money>(
      (accumulated, line) => accumulated.plus(line.unitPrice.times(line.quantity.value)),
      Money.zero(this.currency),
    )
  }

  subtotalOf(sku: Sku): Money | null {
    const line = this.lines.find((candidate) => candidate.sku.equals(sku))

    return line === undefined ? null : line.unitPrice.times(line.quantity.value)
  }

  quantityOf(sku: Sku): number {
    return this.lines.find((line) => line.sku.equals(sku))?.quantity.value ?? 0
  }

  /**
   * Anade unidades de un producto.
   *
   * Si la referencia ya esta en el pedido se acumula la cantidad y **se
   * conserva el precio de la primera vez**: el precio pactado no cambia porque
   * la persona anada una unidad mas.
   */
  addLine(sku: Sku, unitPrice: Money, quantity: Quantity): void {
    this.assertEditable()

    if (unitPrice.currency !== this.currency) {
      throw new DomainError(
        `El pedido esta en ${this.currency} y la linea llega en ${unitPrice.currency}.`,
      )
    }

    if (unitPrice.isZero()) {
      throw new DomainError('Una linea de pedido no puede tener precio unitario cero.')
    }

    const existing = this.lines.find((line) => line.sku.equals(sku))

    if (existing === undefined) {
      this.lines.push({ sku, unitPrice, quantity })

      return
    }

    existing.quantity = existing.quantity.plus(quantity)
  }

  /**
   * Fija la cantidad de una linea a un valor exacto.
   *
   * Es una operacion distinta de `addLine`, que **acumula**. Quien modifica la
   * cantidad desde el carrito indica cuantas unidades quiere en total, no
   * cuantas quiere anadir; resolverlo con `addLine` obligaria a la interfaz a
   * calcular la diferencia, y ese calculo es justo la clase de regla que no
   * debe vivir en el cliente.
   *
   * El precio unitario NO se recalcula: sigue siendo el que se pacto al anadir
   * la linea, por la misma razon que `addLine` lo conserva.
   */
  changeLineQuantity(sku: Sku, quantity: Quantity): void {
    this.assertEditable()

    const line = this.lines.find((candidate) => candidate.sku.equals(sku))

    if (line === undefined) {
      throw new DomainError(`El pedido ${this.id.value} no contiene la referencia "${sku.value}".`)
    }

    line.quantity = quantity
  }

  removeLine(sku: Sku): void {
    this.assertEditable()

    const index = this.lines.findIndex((line) => line.sku.equals(sku))

    if (index === -1) {
      throw new DomainError(`El pedido ${this.id.value} no contiene la referencia "${sku.value}".`)
    }

    this.lines.splice(index, 1)
  }

  /**
   * Confirma el pedido. A partir de aqui el contenido queda congelado.
   */
  confirm(occurredAt: Date): void {
    this.assertEditable()

    if (this.isEmpty) {
      throw new DomainError(`El pedido ${this.id.value} no tiene lineas y no puede confirmarse.`)
    }

    const total = this.total
    this.status = OrderStatus.Confirmed

    this.events.push(
      orderConfirmed({
        aggregateId: this.id.value,
        customerId: this.customerId.value,
        totalAmount: total.amount,
        currency: total.currency,
        lineCount: this.lines.length,
        occurredAt,
      }),
    )
  }

  cancel(reason: string, occurredAt: Date): void {
    if (this.status === OrderStatus.Cancelled) {
      throw new DomainError(`El pedido ${this.id.value} ya esta cancelado.`)
    }

    this.status = OrderStatus.Cancelled

    this.events.push(
      orderCancelled({
        aggregateId: this.id.value,
        customerId: this.customerId.value,
        reason,
        occurredAt,
      }),
    )
  }

  pullEvents(): readonly DomainEvent[] {
    const pulled = [...this.events]
    this.events.length = 0

    return pulled
  }

  toSnapshot(): OrderSnapshot {
    const total = this.total

    return {
      id: this.id.value,
      customerId: this.customerId.value,
      status: this.status,
      currency: this.currency,
      totalAmount: total.amount,
      itemCount: this.itemCount,
      lines: this.lines
        .map((line) => ({
          sku: line.sku.value,
          unitPriceAmount: line.unitPrice.amount,
          quantity: line.quantity.value,
          subtotalAmount: line.unitPrice.times(line.quantity.value).amount,
        }))
        .sort((a, b) => a.sku.localeCompare(b.sku)),
    }
  }

  /**
   * Un pedido confirmado o cancelado no admite cambios. La regla se concentra
   * aqui para que ninguna operacion de mutacion pueda saltarsela por descuido.
   */
  private assertEditable(): void {
    if (this.status === OrderStatus.Confirmed) {
      throw new DomainError(
        `El pedido ${this.id.value} esta confirmado y no admite modificaciones.`,
      )
    }

    if (this.status === OrderStatus.Cancelled) {
      throw new DomainError(`El pedido ${this.id.value} esta cancelado y no admite modificaciones.`)
    }
  }
}
