import { randomUUID } from 'node:crypto'
import { sql, type Kysely } from 'kysely'
import { startTestPostgres, type TestPostgres } from './postgres-runtime'
import { createDatabase, migrateToLatest } from '../../src/infrastructure/persistence/database'
import type { Database } from '../../src/adapters/outbound/persistence/schema'
import { PostgresPurchaseStore } from '../../src/adapters/outbound/persistence/PostgresPurchaseStore'
import { PostgresOrderRepository } from '../../src/adapters/outbound/persistence/PostgresOrderRepository'
import { PostgresWishlistRepository } from '../../src/adapters/outbound/persistence/PostgresWishlistRepository'
import { PostgresSavedCartRepository } from '../../src/adapters/outbound/persistence/PostgresSavedCartRepository'
import {
  CheckoutConflictError,
  type PurchaseAttempt,
} from '../../src/application/ports/CommerceIntegrationPorts'
import { Order } from '../../src/domain/entities/Order'
import { SavedCart } from '../../src/domain/entities/SavedCart'
import {
  CustomerId,
  OrderId,
  Sku,
  Money,
  Quantity,
} from '../../src/domain/value-objects/commerce-values'

describe('Compras persistentes y concurrencia PostgreSQL', () => {
  let server: TestPostgres
  let db: Kysely<Database>
  let orders: PostgresOrderRepository
  let store: PostgresPurchaseStore
  const productId = '11111111-1111-4111-8111-111111111111'
  const secondId = '22222222-2222-4222-8222-222222222222'
  beforeAll(async () => {
    server = await startTestPostgres()
    db = createDatabase({ connectionString: server.getConnectionUri() })
    const result = await migrateToLatest(db)
    if (result.error instanceof Error) throw result.error
    if (result.error !== undefined) throw new Error('La migración de prueba falló.')
    orders = new PostgresOrderRepository(db)
    store = new PostgresPurchaseStore(db)
  })
  afterAll(async () => {
    await db.destroy()
    await server.stop()
  })
  beforeEach(async () => {
    await sql`truncate purchase_mail_outbox, purchase_attempts, order_lines, orders, saved_cart_items, wishlist_items`.execute(
      db,
    )
  })

  const prepare = async (): Promise<{ order: Order; attempt: PurchaseAttempt }> => {
    const order = Order.draft({
      id: OrderId.create(randomUUID()),
      customerId: CustomerId.create('subject-a'),
      currency: 'COP',
    })
    order.addLine(Sku.create(productId), Money.create(25000, 'COP'), Quantity.create(2), {
      productId,
      catalogSku: 'espada-real',
      name: 'Espada real',
      imageUrl: '/api/v1/catalog/assets/image',
    })
    await orders.save(order)
    const id = randomUUID()
    return {
      order,
      attempt: {
        id,
        orderId: order.id.value,
        customerId: order.customerId.value,
        state: 'RESERVING',
        snapshot: order.toSnapshot(),
        failure: null,
        paymentReference: 'sim-' + id,
        maskedCard: '1234',
        notification: {
          notificationId: id,
          orderId: order.id.value,
          recipient: 'test@example.invalid',
          currency: 'COP',
          total: 50000,
          items: [{ productId, name: 'Espada real', quantity: 2, unitPrice: 25000 }],
        },
      },
    }
  }

  it('congela una sola version bajo dos pagos concurrentes y persiste sin datos de tarjeta', async () => {
    const { order, attempt } = await prepare()
    const other = { ...attempt, id: randomUUID() }
    const results = await Promise.all([
      store.start(attempt, order.persistenceVersion),
      store.start(other, order.persistenceVersion),
    ])
    expect(results[0].id).toBe(results[1].id)
    expect(await db.selectFrom('purchase_attempts').selectAll().execute()).toHaveLength(1)
    const frozen = await orders.findById(order.id)
    expect(frozen?.currentStatus).toBe('PROCESSING')
    expect(frozen?.persistenceVersion).toBe(order.persistenceVersion + 1)
    await expect(orders.save(order)).rejects.toBeInstanceOf(CheckoutConflictError)
    expect(
      JSON.stringify(await db.selectFrom('purchase_attempts').select('payload').execute()),
    ).not.toMatch(/securityCode|accessToken|holder|expiry/)
  })

  it('completa pedido, intento y outbox juntos; el reinicio y doble cierre no duplican correo', async () => {
    const { order, attempt } = await prepare()
    await store.start(attempt, order.persistenceVersion)
    await expect(store.complete(attempt)).rejects.toBeInstanceOf(CheckoutConflictError)
    await store.advance(attempt.id, 'RESERVING', 'RESERVED')
    await store.advance(attempt.id, 'RESERVED', 'DELIVERED')
    const restarted = new PostgresPurchaseStore(db)
    expect((await restarted.pending())[0]?.state).toBe('DELIVERED')
    await Promise.all([restarted.complete(attempt), store.complete(attempt)])
    expect((await orders.findById(order.id))?.currentStatus).toBe('CONFIRMED')
    expect(await restarted.pending()).toEqual([])
    expect(await restarted.pendingMail()).toEqual([attempt.notification])
    expect(await restarted.wasPurchased('subject-a', productId)).toBe(true)
    expect(await restarted.wasPurchased('subject-b', productId)).toBe(false)
    await restarted.markMailSent(attempt.id)
    expect(await restarted.pendingMail()).toEqual([])
    expect((await restarted.findByOrder(order.id.value))?.state).toBe('COMPLETED')
    expect(await restarted.findByOrder('missing')).toBeNull()
  })

  it('un fallo al insertar outbox revierte tambien la confirmacion del pedido', async () => {
    const { order, attempt } = await prepare()
    await store.start(attempt, order.persistenceVersion)
    await store.advance(attempt.id, 'RESERVING', 'RESERVED')
    await store.advance(attempt.id, 'RESERVED', 'DELIVERED')
    await sql`alter table purchase_mail_outbox add constraint simulated_write_failure check (false)`.execute(
      db,
    )
    try {
      await expect(store.complete(attempt)).rejects.toThrow()
    } finally {
      await sql`alter table purchase_mail_outbox drop constraint simulated_write_failure`.execute(
        db,
      )
    }
    expect((await orders.findById(order.id))?.currentStatus).toBe('PROCESSING')
    expect((await store.findByOrder(order.id.value))?.state).toBe('DELIVERED')
    await store.complete(attempt)
    expect(await store.pendingMail()).toHaveLength(1)
  })

  it('un rechazo seguro conserva carrito y permite un nuevo intento; no permite liberar una entrega', async () => {
    const { order, attempt } = await prepare()
    await store.start(attempt, order.persistenceVersion)
    await store.fail(attempt, 'Sin existencias')
    await store.fail(attempt, 'Reintento tardio')
    expect((await orders.findById(order.id))?.toSnapshot().lines[0]?.quantity).toBe(2)
    expect((await store.findByOrder(order.id.value))?.failure).toBe('Sin existencias')
    const current = await orders.findById(order.id)
    const next = { ...attempt, id: randomUUID(), snapshot: current!.toSnapshot() }
    await store.start(next, current!.persistenceVersion)
    await store.advance(next.id, 'RESERVING', 'RESERVED')
    await expect(store.fail(next, 'Desconocido')).rejects.toBeInstanceOf(CheckoutConflictError)
    await store.advance(next.id, 'RESERVED', 'RELEASING', 'Inventario lleno')
    await store.fail(next, 'Inventario lleno')
    expect((await orders.findById(order.id))?.currentStatus).toBe('DRAFT')
    expect(await store.pendingMail()).toEqual([])
  })

  it('rechaza resumen obsoleto y propietario equivocado sin abrir intento', async () => {
    const { order, attempt } = await prepare()
    await expect(store.start(attempt, 0)).rejects.toBeInstanceOf(CheckoutConflictError)
    await expect(
      store.start({ ...attempt, customerId: 'subject-b' }, order.persistenceVersion),
    ).rejects.toBeInstanceOf(CheckoutConflictError)
    expect(await store.pending()).toEqual([])
  })

  it('el motor admite UUID canónico y mantiene un solo carrito vivo por cliente', async () => {
    const { order } = await prepare()
    const second = Order.draft({
      id: OrderId.create(randomUUID()),
      customerId: order.customerId,
      currency: 'COP',
    })
    await expect(orders.save(second)).rejects.toMatchObject({
      code: '23505',
      constraint: 'orders_one_live_cart',
    })
    expect((await orders.findById(order.id))?.toSnapshot().lines[0]).toMatchObject({
      productId,
      name: 'Espada real',
      catalogSku: 'espada-real',
    })
  })

  it('no pierde deseos distintos concurrentes y conserva metadatos del carrito guardado', async () => {
    const { order } = await prepare()
    const wishlist = new PostgresWishlistRepository(db)
    await Promise.all([
      wishlist.setDesired(order.customerId, Sku.create(productId), true),
      wishlist.setDesired(order.customerId, Sku.create(secondId), true),
    ])
    expect((await wishlist.findByCustomer(order.customerId))?.toSnapshot().skus).toHaveLength(2)
    await wishlist.setDesired(order.customerId, Sku.create(productId), false)
    expect((await wishlist.findByCustomer(order.customerId))?.toSnapshot().skus).toEqual([secondId])
    const saved = new PostgresSavedCartRepository(db)
    await saved.save(SavedCart.fromOrder(order.toSnapshot()))
    expect((await saved.findByCustomer(order.customerId))?.toSnapshot().items[0]).toMatchObject({
      productId,
      name: 'Espada real',
      catalogSku: 'espada-real',
    })
    expect(await saved.findByCustomer(CustomerId.create('subject-b'))).toBeNull()
    await saved.deleteByCustomer(order.customerId)
    expect(await saved.findByCustomer(order.customerId)).toBeNull()
  })
})
