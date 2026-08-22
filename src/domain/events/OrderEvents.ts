import type { DomainEvent } from './DomainEvent'

export interface OrderConfirmed extends DomainEvent {
  readonly name: 'commerce.order.confirmed'
  readonly customerId: string
  readonly totalAmount: number
  readonly currency: string
  readonly lineCount: number
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
  lineCount: number
  occurredAt: Date
}): OrderConfirmed => ({
  name: 'commerce.order.confirmed',
  aggregateId: params.aggregateId,
  customerId: params.customerId,
  totalAmount: params.totalAmount,
  currency: params.currency,
  lineCount: params.lineCount,
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
