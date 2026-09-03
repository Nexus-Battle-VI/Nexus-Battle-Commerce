import { DomainError } from '../../domain/errors/DomainError'
import { OrderId } from '../../domain/value-objects/commerce-values'
import type { OrderLineSnapshot } from '../../domain/entities/Order'
import { OrderNotFoundError } from '../errors/ApplicationError'
import { toOrderDto } from '../dto/OrderDto'
import type { OrderRepositoryPort } from '../ports/OrderRepositoryPort'
import type { ProductPricingPort } from '../ports/ProductPricingPort'
import type { PaymentGatewayPort } from '../ports/PaymentGatewayPort'
import type { IdGeneratorPort } from '../ports/IdGeneratorPort'
import type { ClockPort } from '../ports/ClockPort'
import {
  CheckoutConflictError,
  IntegrationRejectedError,
  IntegrationUnavailableError,
  type CatalogReservationPort,
  type InventoryGrantPort,
  type PurchaseAttempt,
  type PurchaseMailPort,
  type PurchaseRecipientPort,
  type PurchaseStatus,
  type PurchaseStorePort,
} from '../ports/CommerceIntegrationPorts'
import { PaymentDeclinedError, type CheckoutCommand } from './CheckoutUseCases'

export interface IntegratedCheckoutDependencies {
  readonly orders: OrderRepositoryPort
  readonly pricing: ProductPricingPort
  readonly payments: PaymentGatewayPort
  readonly ids: IdGeneratorPort
  readonly store: PurchaseStorePort
  readonly reservations: CatalogReservationPort
  readonly inventory: InventoryGrantPort
  readonly recipient: PurchaseRecipientPort
  readonly mail: PurchaseMailPort
  readonly clock?: ClockPort
}

export const RECOVERY_RETRY_DELAY_MS = 2000

export class IntegratedCheckout {
  constructor(private readonly deps: IntegratedCheckoutDependencies) {}

  async execute(command: CheckoutCommand): Promise<PurchaseStatus> {
    const previous = await this.deps.store.findByOrder(command.orderId)
    if (previous !== null && previous.state !== 'FAILED') {
      await this.resume(previous)
      return this.status(command.orderId)
    }
    const order = await this.deps.orders.findById(OrderId.create(command.orderId))
    if (order === null) throw new OrderNotFoundError(command.orderId)
    if (!order.isEditable || order.isEmpty)
      throw new DomainError('El carrito no admite una compra.')
    if (
      command.expectedVersion !== undefined &&
      command.expectedVersion !== order.persistenceVersion
    )
      throw new CheckoutConflictError('El carrito cambio; vuelve a revisar el resumen.')
    const snapshot = order.toSnapshot()
    const lines: OrderLineSnapshot[] = []
    for (const line of snapshot.lines) {
      const product = await this.deps.pricing.priceOf(line.productId ?? line.sku)
      if (
        product?.productId === undefined ||
        product.currency !== snapshot.currency ||
        (product.availableUnits != null && product.availableUnits < line.quantity)
      )
        throw new IntegrationRejectedError(
          'Un producto no esta disponible con las condiciones del carrito.',
        )
      if (lines.some((existing) => existing.productId === product.productId))
        throw new CheckoutConflictError(
          'El carrito repite una referencia antigua y canonica; revisa sus cantidades.',
        )
      lines.push({
        ...line,
        sku: product.productId,
        productId: product.productId,
        catalogSku: product.sku,
        ...(product.name === undefined ? {} : { name: product.name }),
        ...(product.imageUrl === undefined ? {} : { imageUrl: product.imageUrl }),
      })
    }
    const recipient = await this.deps.recipient.resolve(
      snapshot.customerId,
      command.accessToken ?? '',
    )
    const id = this.deps.ids.generate()
    const payment = await this.deps.payments.charge({
      transactionId: id,
      amount: snapshot.totalAmount,
      currency: snapshot.currency,
      card: command.card,
    })
    if (!payment.approved || payment.reference === null)
      throw new PaymentDeclinedError(
        payment.declineReason ?? 'Pago simulado rechazado.',
        payment.maskedCard,
      )
    const attempt: PurchaseAttempt = {
      id,
      orderId: snapshot.id,
      customerId: snapshot.customerId,
      state: 'RESERVING',
      snapshot: { ...snapshot, lines },
      paymentReference: payment.reference,
      maskedCard: payment.maskedCard,
      failure: null,
      notification: {
        notificationId: id,
        orderId: snapshot.id,
        recipient,
        items: lines.map((line) => ({
          productId: line.productId ?? line.sku,
          name: line.name ?? line.catalogSku ?? line.sku,
          quantity: line.quantity,
          unitPrice: line.unitPriceAmount,
        })),
        currency: snapshot.currency,
        total: snapshot.totalAmount,
      },
    }
    const stored = await this.deps.store.start(attempt, order.persistenceVersion)
    await this.resume(stored)
    return this.status(command.orderId)
  }

  async status(orderId: string): Promise<PurchaseStatus> {
    const attempt = await this.deps.store.findByOrder(orderId)
    if (attempt === null) throw new OrderNotFoundError(orderId)
    if (attempt.state === 'FAILED')
      throw new IntegrationRejectedError(
        attempt.failure ?? 'No se completo la compra; el carrito sigue disponible.',
      )
    const order = await this.deps.orders.findById(OrderId.create(orderId))
    if (order === null) throw new OrderNotFoundError(orderId)
    return {
      status: attempt.state === 'COMPLETED' ? 'COMPLETED' : 'PROCESSING',
      order: toOrderDto(order.toSnapshot()),
      paymentReference: attempt.paymentReference,
      maskedCard: attempt.maskedCard,
    }
  }

  async resume(initial: PurchaseAttempt): Promise<void> {
    let attempt = await this.deps.store.findByOrder(initial.orderId)
    if (attempt?.id !== initial.id) return
    const lines = attempt.notification.items.map(({ productId, quantity }) => ({
      productId,
      quantity,
    }))
    try {
      if (attempt.state === 'RESERVING') {
        try {
          await this.deps.reservations.reserve({
            reservationId: attempt.id,
            playerId: attempt.customerId,
            lines,
          })
        } catch (error: unknown) {
          if (error instanceof IntegrationRejectedError) {
            await this.deps.store.fail(attempt, error.message)
            return
          }
          throw error
        }
        await this.deps.store.advance(attempt.id, 'RESERVING', 'RESERVED')
      }
      attempt = await this.deps.store.findByOrder(initial.orderId)
      if (attempt?.id !== initial.id) return
      if (attempt.state === 'RESERVED') {
        try {
          await this.deps.inventory.grant({
            operationId: attempt.id,
            playerId: attempt.customerId,
            items: lines,
          })
          await this.deps.store.advance(attempt.id, 'RESERVED', 'DELIVERED')
        } catch (error: unknown) {
          if (error instanceof IntegrationRejectedError)
            await this.deps.store.advance(attempt.id, 'RESERVED', 'RELEASING', error.message)
          else throw error
        }
      }
      attempt = await this.deps.store.findByOrder(initial.orderId)
      if (attempt?.id !== initial.id) return
      if (attempt.state === 'RELEASING') {
        await this.deps.reservations.release(attempt.id, attempt.customerId)
        await this.deps.store.fail(attempt, attempt.failure ?? 'El inventario rechazo la entrega.')
      } else if (attempt.state === 'DELIVERED') {
        await this.deps.reservations.confirm(attempt.id, attempt.customerId)
        await this.deps.store.complete(attempt)
      }
    } catch (error: unknown) {
      if (error instanceof IntegrationUnavailableError) return
      // Storage failures also leave a durable previous stage. Surface them; recovery can retry.
      throw error
    }
  }

  async recover(): Promise<void> {
    const errors: unknown[] = []
    const now = (): Date => this.deps.clock?.now() ?? new Date()
    const retryAt = (): Date => new Date(now().getTime() + RECOVERY_RETRY_DELAY_MS)
    for (const attempt of await this.deps.store.dueAttempts(now())) {
      try {
        await this.resume(attempt)
        // resume preserves uncertain effects in a durable stage. Reprogram it
        // even when the remote timeout was represented as PROCESSING.
        await this.deps.store.deferAttempt(attempt.id, retryAt())
      } catch (error: unknown) {
        errors.push(error)
        try {
          await this.deps.store.deferAttempt(attempt.id, retryAt())
        } catch (deferError: unknown) {
          errors.push(deferError)
        }
      }
    }
    for (const notification of await this.deps.store.dueMail(now())) {
      try {
        await this.deps.mail.send(notification)
        await this.deps.store.markMailSent(notification.notificationId)
      } catch (error: unknown) {
        if (!(error instanceof IntegrationUnavailableError)) errors.push(error)
        try {
          await this.deps.store.deferMail(notification.notificationId, retryAt())
        } catch (deferError: unknown) {
          errors.push(deferError)
        }
      }
    }
    // A faulty entry cannot prevent independent orders or notifications from
    // being attempted. Unexpected failures still reach the worker's logger.
    if (errors.length > 0) throw errors[0]
  }
}
