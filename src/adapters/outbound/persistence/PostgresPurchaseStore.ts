import type { Kysely } from 'kysely'
import {
  CheckoutConflictError,
  type PurchaseAttempt,
  type PurchaseNotification,
  type PurchaseState,
  type PurchaseStorePort,
} from '../../../application/ports/CommerceIntegrationPorts'
import type { Database } from './schema'

const decode = (row: {
  payload: unknown
  state: string
  failure: string | null
}): PurchaseAttempt => {
  const payload =
    typeof row.payload === 'string'
      ? (JSON.parse(row.payload) as PurchaseAttempt)
      : (row.payload as PurchaseAttempt)
  return { ...payload, state: row.state as PurchaseState, failure: row.failure }
}

export class PostgresPurchaseStore implements PurchaseStorePort {
  constructor(private readonly db: Kysely<Database>) {}

  async start(attempt: PurchaseAttempt, expectedVersion: number): Promise<PurchaseAttempt> {
    return this.db.transaction().execute(async (trx) => {
      const order = await trx
        .selectFrom('orders')
        .selectAll()
        .where('id', '=', attempt.orderId)
        .forUpdate()
        .executeTakeFirst()
      if (order?.customer_id !== attempt.customerId)
        throw new CheckoutConflictError('El pedido no esta disponible.')
      const active = await trx
        .selectFrom('purchase_attempts')
        .selectAll()
        .where('order_id', '=', attempt.orderId)
        .where('state', '!=', 'FAILED')
        .executeTakeFirst()
      if (active !== undefined) return decode(active)
      if (order.status !== 'DRAFT' || order.version !== expectedVersion)
        throw new CheckoutConflictError(
          'El carrito cambio; revisa de nuevo el resumen antes de confirmar.',
        )
      await trx
        .insertInto('purchase_attempts')
        .values({
          id: attempt.id,
          order_id: attempt.orderId,
          customer_id: attempt.customerId,
          state: attempt.state,
          payload: JSON.stringify(attempt),
          failure: null,
        })
        .execute()
      await trx
        .updateTable('orders')
        .set({ status: 'PROCESSING', version: order.version + 1, updated_at: new Date() })
        .where('id', '=', attempt.orderId)
        .execute()
      // Resolve old SKU lines at the same atomic boundary that freezes the attempt.
      await trx.deleteFrom('order_lines').where('order_id', '=', attempt.orderId).execute()
      await trx
        .insertInto('order_lines')
        .values(
          attempt.snapshot.lines.map((line) => ({
            order_id: attempt.orderId,
            sku: line.sku,
            product_id: line.productId ?? null,
            catalog_sku: line.catalogSku ?? null,
            product_name: line.name ?? null,
            image_url: line.imageUrl ?? null,
            unit_price_amount: String(line.unitPriceAmount),
            quantity: line.quantity,
          })),
        )
        .execute()
      return attempt
    })
  }

  async findByOrder(orderId: string): Promise<PurchaseAttempt | null> {
    const row = await this.db
      .selectFrom('purchase_attempts')
      .selectAll()
      .where('order_id', '=', orderId)
      .orderBy('updated_at', 'desc')
      .orderBy('id', 'desc')
      .executeTakeFirst()
    return row === undefined ? null : decode(row)
  }

  async pending(): Promise<readonly PurchaseAttempt[]> {
    const rows = await this.db
      .selectFrom('purchase_attempts')
      .selectAll()
      .where('state', 'not in', ['COMPLETED', 'FAILED'])
      .orderBy('updated_at')
      .orderBy('id')
      .execute()
    return rows.map(decode)
  }

  async dueAttempts(now: Date): Promise<readonly PurchaseAttempt[]> {
    const rows = await this.db
      .selectFrom('purchase_attempts')
      .selectAll()
      .where('state', 'not in', ['COMPLETED', 'FAILED'])
      .where('next_attempt_at', '<=', now)
      .orderBy('next_attempt_at')
      .orderBy('id')
      .limit(50)
      .execute()
    return rows.map(decode)
  }

  async deferAttempt(id: string, nextAttemptAt: Date): Promise<void> {
    await this.db
      .updateTable('purchase_attempts')
      .set({ next_attempt_at: nextAttemptAt })
      .where('id', '=', id)
      .where('state', 'not in', ['COMPLETED', 'FAILED'])
      .execute()
  }

  async advance(
    id: string,
    from: PurchaseState,
    to: PurchaseState,
    failure?: string,
  ): Promise<void> {
    await this.db
      .updateTable('purchase_attempts')
      .set({
        state: to,
        updated_at: new Date(),
        next_attempt_at: new Date(),
        ...(failure === undefined ? {} : { failure }),
      })
      .where('id', '=', id)
      .where('state', '=', from)
      .execute()
  }

  async complete(attempt: PurchaseAttempt): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      const row = await trx
        .selectFrom('purchase_attempts')
        .selectAll()
        .where('id', '=', attempt.id)
        .forUpdate()
        .executeTakeFirstOrThrow()
      if (row.state === 'COMPLETED') return
      if (row.state !== 'DELIVERED')
        throw new CheckoutConflictError('La entrega aun no esta confirmada.')
      const order = await trx
        .selectFrom('orders')
        .selectAll()
        .where('id', '=', attempt.orderId)
        .forUpdate()
        .executeTakeFirstOrThrow()
      if (order.status !== 'PROCESSING')
        throw new CheckoutConflictError('Estado de pedido incompatible con la compra.')
      await trx
        .updateTable('orders')
        .set({ status: 'CONFIRMED', version: order.version + 1, updated_at: new Date() })
        .where('id', '=', attempt.orderId)
        .execute()
      await trx
        .updateTable('purchase_attempts')
        .set({ state: 'COMPLETED', updated_at: new Date() })
        .where('id', '=', attempt.id)
        .execute()
      await trx
        .insertInto('purchase_mail_outbox')
        .values({
          id: attempt.notification.notificationId,
          payload: JSON.stringify(attempt.notification),
          sent_at: null,
        })
        .onConflict((oc) => oc.column('id').doNothing())
        .execute()
    })
  }

  async fail(attempt: PurchaseAttempt, failure: string): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      const row = await trx
        .selectFrom('purchase_attempts')
        .selectAll()
        .where('id', '=', attempt.id)
        .forUpdate()
        .executeTakeFirstOrThrow()
      if (row.state === 'FAILED') return
      if (!['RESERVING', 'RELEASING'].includes(row.state))
        throw new CheckoutConflictError(
          'La compra no admite cancelacion sin recuperar sus efectos.',
        )
      const order = await trx
        .selectFrom('orders')
        .selectAll()
        .where('id', '=', attempt.orderId)
        .forUpdate()
        .executeTakeFirstOrThrow()
      if (order.status !== 'PROCESSING')
        throw new CheckoutConflictError('Estado del carrito incompatible.')
      await trx
        .updateTable('orders')
        .set({ status: 'DRAFT', version: order.version + 1, updated_at: new Date() })
        .where('id', '=', attempt.orderId)
        .execute()
      await trx
        .updateTable('purchase_attempts')
        .set({ state: 'FAILED', failure, updated_at: new Date() })
        .where('id', '=', attempt.id)
        .execute()
    })
  }

  async pendingMail(): Promise<readonly PurchaseNotification[]> {
    const rows = await this.db
      .selectFrom('purchase_mail_outbox')
      .select('payload')
      .where('sent_at', 'is', null)
      .orderBy('created_at')
      .orderBy('id')
      .execute()
    return rows.map((row) =>
      typeof row.payload === 'string'
        ? (JSON.parse(row.payload) as PurchaseNotification)
        : (row.payload as PurchaseNotification),
    )
  }

  async dueMail(now: Date): Promise<readonly PurchaseNotification[]> {
    const rows = await this.db
      .selectFrom('purchase_mail_outbox')
      .select('payload')
      .where('sent_at', 'is', null)
      .where('next_attempt_at', '<=', now)
      .orderBy('next_attempt_at')
      .orderBy('id')
      .limit(50)
      .execute()
    return rows.map((row) =>
      typeof row.payload === 'string'
        ? (JSON.parse(row.payload) as PurchaseNotification)
        : (row.payload as PurchaseNotification),
    )
  }

  async deferMail(notificationId: string, nextAttemptAt: Date): Promise<void> {
    await this.db
      .updateTable('purchase_mail_outbox')
      .set({ next_attempt_at: nextAttemptAt })
      .where('id', '=', notificationId)
      .where('sent_at', 'is', null)
      .execute()
  }

  async markMailSent(notificationId: string): Promise<void> {
    await this.db
      .updateTable('purchase_mail_outbox')
      .set({ sent_at: new Date() })
      .where('id', '=', notificationId)
      .execute()
  }

  async wasPurchased(customerId: string, productId: string): Promise<boolean> {
    const rows = await this.db
      .selectFrom('purchase_attempts')
      .selectAll()
      .where('customer_id', '=', customerId)
      .where('state', '=', 'COMPLETED')
      .execute()
    return rows.some((row) =>
      decode(row).notification.items.some((item) => item.productId === productId),
    )
  }
}
