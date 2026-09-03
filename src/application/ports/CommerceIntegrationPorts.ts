import type { OrderDto } from '../dto/OrderDto'
import type { OrderSnapshot } from '../../domain/entities/Order'

export class IntegrationUnavailableError extends Error {}
export class IntegrationRejectedError extends Error {}
export class CheckoutConflictError extends Error {}

export interface PurchaseLine {
  readonly productId: string
  readonly name: string
  readonly quantity: number
  readonly unitPrice: number
}

export interface PurchaseNotification {
  readonly notificationId: string
  readonly orderId: string
  readonly recipient: string
  readonly items: readonly PurchaseLine[]
  readonly currency: string
  readonly total: number
}

export interface ReservationCommand {
  readonly reservationId: string
  readonly playerId: string
  readonly lines: readonly { productId: string; quantity: number }[]
}

export interface CatalogReservationPort {
  reserve(command: ReservationCommand): Promise<void>
  confirm(reservationId: string, playerId: string): Promise<void>
  release(reservationId: string, playerId: string): Promise<void>
}

export interface InventoryGrantPort {
  grant(command: {
    readonly operationId: string
    readonly playerId: string
    readonly items: readonly { productId: string; quantity: number }[]
  }): Promise<void>
}

export interface PurchaseMailPort {
  send(notification: PurchaseNotification): Promise<void>
}

export interface PurchaseRecipientPort {
  /** Resolves the authenticated subject through Account; never accepts a client email. */
  resolve(subject: string, accessToken: string): Promise<string>
}

export type PurchaseState =
  'RESERVING' | 'RESERVED' | 'DELIVERED' | 'RELEASING' | 'COMPLETED' | 'FAILED'

export interface PurchaseAttempt {
  readonly id: string
  readonly orderId: string
  readonly customerId: string
  readonly state: PurchaseState
  readonly snapshot: OrderSnapshot
  readonly notification: PurchaseNotification
  readonly paymentReference: string
  readonly maskedCard: string
  readonly failure: string | null
}

export interface PurchaseStatus {
  readonly status: 'COMPLETED' | 'PROCESSING'
  readonly order: OrderDto
  readonly paymentReference: string
  readonly maskedCard: string
}

export interface PurchaseStorePort {
  /** Atomically freezes the current version and inserts the attempt before any remote effect. */
  start(attempt: PurchaseAttempt, expectedVersion: number): Promise<PurchaseAttempt>
  findByOrder(orderId: string): Promise<PurchaseAttempt | null>
  /** Observation includes deferred work; recovery selects only due entries. */
  pending(): Promise<readonly PurchaseAttempt[]>
  dueAttempts(now: Date): Promise<readonly PurchaseAttempt[]>
  deferAttempt(id: string, nextAttemptAt: Date): Promise<void>
  advance(id: string, from: PurchaseState, to: PurchaseState, failure?: string): Promise<void>
  /** Completes order, attempt and pending mail in one local transaction. */
  complete(attempt: PurchaseAttempt): Promise<void>
  /** Returns the frozen cart to DRAFT only after effects were proven absent or released. */
  fail(attempt: PurchaseAttempt, failure: string): Promise<void>
  pendingMail(): Promise<readonly PurchaseNotification[]>
  dueMail(now: Date): Promise<readonly PurchaseNotification[]>
  deferMail(notificationId: string, nextAttemptAt: Date): Promise<void>
  markMailSent(notificationId: string): Promise<void>
  wasPurchased(customerId: string, productId: string): Promise<boolean>
}

export const PURCHASE_STORE = Symbol('PurchaseStorePort')
export const PURCHASE_RECIPIENT = Symbol('PurchaseRecipientPort')
export const CATALOG_RESERVATIONS = Symbol('CatalogReservationPort')
export const INVENTORY_GRANT = Symbol('InventoryGrantPort')
export const PURCHASE_MAIL = Symbol('PurchaseMailPort')
export const PURCHASE_RECOVERY = Symbol('PurchaseRecovery')
