import {
  CheckoutConflictError,
  type PurchaseAttempt,
  type PurchaseNotification,
  type PurchaseState,
  type PurchaseStorePort,
} from '../../../application/ports/CommerceIntegrationPorts'
import type { OrderRepositoryPort } from '../../../application/ports/OrderRepositoryPort'
import { OrderId } from '../../../domain/value-objects/commerce-values'

/** Explicit test/development adapter. The production composition requires PostgreSQL. */
export class InMemoryPurchaseStore implements PurchaseStorePort {
  private readonly attempts = new Map<string, PurchaseAttempt>()
  private readonly mail = new Map<string, PurchaseNotification>()
  private readonly attemptDueAt = new Map<string, number>()
  private readonly mailDueAt = new Map<string, number>()
  private serial: Promise<unknown> = Promise.resolve()
  constructor(private readonly orders: OrderRepositoryPort) {}
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = this.serial.then(work)
    this.serial = result.catch(() => undefined)
    return result
  }
  async start(attempt: PurchaseAttempt, expectedVersion: number): Promise<PurchaseAttempt> {
    return this.exclusive(async () => {
      const existing = [...this.attempts.values()].find(
        (value) => value.orderId === attempt.orderId && value.state !== 'FAILED',
      )
      if (existing !== undefined) return structuredClone(existing)
      const order = await this.orders.findById(OrderId.create(attempt.orderId))
      if (order === null || !order.isEditable || order.persistenceVersion !== expectedVersion)
        throw new CheckoutConflictError('El carrito cambio; revisa el resumen.')
      order.beginCheckout()
      await this.orders.save(order)
      this.attempts.set(attempt.id, structuredClone(attempt))
      this.attemptDueAt.set(attempt.id, Date.now())
      return structuredClone(attempt)
    })
  }
  findByOrder(orderId: string): Promise<PurchaseAttempt | null> {
    const found = [...this.attempts.values()].reverse().find((a) => a.orderId === orderId)
    return Promise.resolve(found === undefined ? null : structuredClone(found))
  }
  pending(): Promise<readonly PurchaseAttempt[]> {
    return Promise.resolve(
      structuredClone(
        [...this.attempts.values()].filter((a) => !['COMPLETED', 'FAILED'].includes(a.state)),
      ),
    )
  }
  async dueAttempts(now: Date): Promise<readonly PurchaseAttempt[]> {
    return (await this.pending())
      .filter((attempt) => (this.attemptDueAt.get(attempt.id) ?? 0) <= now.getTime())
      .sort(
        (a, b) =>
          (this.attemptDueAt.get(a.id) ?? 0) - (this.attemptDueAt.get(b.id) ?? 0) ||
          a.id.localeCompare(b.id),
      )
      .slice(0, 50)
  }
  deferAttempt(id: string, nextAttemptAt: Date): Promise<void> {
    const attempt = this.attempts.get(id)
    if (attempt !== undefined && !['COMPLETED', 'FAILED'].includes(attempt.state))
      this.attemptDueAt.set(id, nextAttemptAt.getTime())
    return Promise.resolve()
  }
  advance(id: string, from: PurchaseState, to: PurchaseState, failure?: string): Promise<void> {
    const value = this.attempts.get(id)
    if (value?.state === from) {
      this.attempts.set(id, { ...value, state: to, failure: failure ?? value.failure })
      this.attemptDueAt.set(id, Date.now())
    }
    return Promise.resolve()
  }
  async complete(attempt: PurchaseAttempt): Promise<void> {
    return this.exclusive(async () => {
      const current = this.attempts.get(attempt.id)
      if (current?.state === 'COMPLETED') return
      if (current?.state !== 'DELIVERED')
        throw new CheckoutConflictError('La compra no esta entregada.')
      const order = await this.orders.findById(OrderId.create(attempt.orderId))
      if (order === null) throw new CheckoutConflictError('Pedido ausente.')
      order.completeCheckout(new Date())
      await this.orders.save(order)
      this.attempts.set(attempt.id, { ...current, state: 'COMPLETED' })
      this.mail.set(attempt.notification.notificationId, structuredClone(attempt.notification))
      this.mailDueAt.set(attempt.notification.notificationId, Date.now())
    })
  }
  async fail(attempt: PurchaseAttempt, failure: string): Promise<void> {
    return this.exclusive(async () => {
      const current = this.attempts.get(attempt.id)
      if (current?.state === 'FAILED') return
      if (current === undefined || !['RESERVING', 'RELEASING'].includes(current.state))
        throw new CheckoutConflictError('Estado incompatible.')
      const order = await this.orders.findById(OrderId.create(attempt.orderId))
      if (order === null) throw new CheckoutConflictError('Pedido ausente.')
      order.resumeDraft()
      await this.orders.save(order)
      this.attempts.set(attempt.id, { ...current, state: 'FAILED', failure })
    })
  }
  pendingMail(): Promise<readonly PurchaseNotification[]> {
    return Promise.resolve(structuredClone([...this.mail.values()]))
  }
  async dueMail(now: Date): Promise<readonly PurchaseNotification[]> {
    return (await this.pendingMail())
      .filter(
        (notification) => (this.mailDueAt.get(notification.notificationId) ?? 0) <= now.getTime(),
      )
      .sort(
        (a, b) =>
          (this.mailDueAt.get(a.notificationId) ?? 0) -
            (this.mailDueAt.get(b.notificationId) ?? 0) ||
          a.notificationId.localeCompare(b.notificationId),
      )
      .slice(0, 50)
  }
  deferMail(notificationId: string, nextAttemptAt: Date): Promise<void> {
    if (this.mail.has(notificationId)) this.mailDueAt.set(notificationId, nextAttemptAt.getTime())
    return Promise.resolve()
  }
  markMailSent(id: string): Promise<void> {
    this.mail.delete(id)
    this.mailDueAt.delete(id)
    return Promise.resolve()
  }
  wasPurchased(customerId: string, productId: string): Promise<boolean> {
    return Promise.resolve(
      [...this.attempts.values()].some(
        (a) =>
          a.customerId === customerId &&
          a.state === 'COMPLETED' &&
          a.notification.items.some((i) => i.productId === productId),
      ),
    )
  }
}
