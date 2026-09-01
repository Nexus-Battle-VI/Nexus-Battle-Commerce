import type { DomainEvent } from './DomainEvent'

/**
 * Linea tal y como viaja en el evento.
 *
 * El evento lleva el **detalle** y no solo el recuento porque HU-60 exige que
 * la confirmacion de compra contenga «el detalle de los productos adquiridos y
 * el total pagado». Si el evento solo dijera cuantas lineas hubo, quien envia
 * el correo tendria que volver a preguntarle a Commerce por el pedido, y esa
 * segunda lectura podria devolver algo distinto de lo que se compro.
 */
export interface ConfirmedLine {
  readonly sku: string
  readonly quantity: number
  readonly unitPriceAmount: number
  readonly subtotalAmount: number
}

export interface OrderConfirmed extends DomainEvent {
  readonly name: 'commerce.order.confirmed'
  readonly customerId: string
  readonly totalAmount: number
  readonly currency: string
  readonly lineCount: number
  readonly lines: readonly ConfirmedLine[]
}

export interface OrderCancelled extends DomainEvent {
  readonly name: 'commerce.order.cancelled'
  readonly customerId: string
  readonly reason: string
}

export const orderConfirmed = (params: {
  aggregateId: string
  customerId: string
  totalAmount: number
  currency: string
  lines: readonly ConfirmedLine[]
  occurredAt: Date
}): OrderConfirmed => ({
  name: 'commerce.order.confirmed',
  aggregateId: params.aggregateId,
  customerId: params.customerId,
  totalAmount: params.totalAmount,
  currency: params.currency,
  lineCount: params.lines.length,
  lines: params.lines,
  occurredAt: params.occurredAt,
})

export const orderCancelled = (params: {
  aggregateId: string
  customerId: string
  reason: string
  occurredAt: Date
}): OrderCancelled => ({
  name: 'commerce.order.cancelled',
  aggregateId: params.aggregateId,
  customerId: params.customerId,
  reason: params.reason,
  occurredAt: params.occurredAt,
})
