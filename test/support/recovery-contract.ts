import {
  IntegratedCheckout,
  RECOVERY_RETRY_DELAY_MS,
} from '../../src/application/use-cases/IntegratedCheckout'
import {
  IntegrationUnavailableError,
  type PurchaseAttempt,
  type PurchaseStorePort,
} from '../../src/application/ports/CommerceIntegrationPorts'
import type { OrderRepositoryPort } from '../../src/application/ports/OrderRepositoryPort'
import { Order } from '../../src/domain/entities/Order'
import {
  CustomerId,
  OrderId,
  Money,
  Quantity,
  Sku,
} from '../../src/domain/value-objects/commerce-values'

export interface RecoveryFixture {
  orders: OrderRepositoryPort
  store: PurchaseStorePort
}
const PRODUCT = '11111111-1111-4111-8111-111111111111'
export const seedAttempt = async (
  { orders, store }: RecoveryFixture,
  index: number,
): Promise<PurchaseAttempt> => {
  const suffix = String(index).padStart(3, '0')
  const order = Order.draft({
    id: OrderId.create(`order-${suffix}`),
    customerId: CustomerId.create(`customer-${suffix}`),
    currency: 'COP',
  })
  order.addLine(Sku.create(PRODUCT), Money.create(100, 'COP'), Quantity.create(1), {
    productId: PRODUCT,
    catalogSku: 'espada',
    name: 'Espada',
  })
  await orders.save(order)
  const id = `attempt-${suffix}`
  const attempt: PurchaseAttempt = {
    id,
    orderId: order.id.value,
    customerId: order.customerId.value,
    state: 'RESERVING',
    snapshot: order.toSnapshot(),
    paymentReference: `sim-${id}`,
    maskedCard: '****1234',
    failure: null,
    notification: {
      notificationId: id,
      orderId: order.id.value,
      recipient: 'person@example.invalid',
      items: [{ productId: PRODUCT, name: 'Espada', quantity: 1, unitPrice: 100 }],
      currency: 'COP',
      total: 100,
    },
  }
  return store.start(attempt, order.persistenceVersion)
}
const workflowFixture = (fixture: RecoveryFixture) => {
  // Controlled recovery time; no sleeps or global fake timers are needed by PG.
  let time = Date.now() + 60_000
  const reservations = {
    reserve: jest.fn<Promise<void>, [{ reservationId: string }]>().mockResolvedValue(undefined),
    confirm: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
  }
  const inventory = { grant: jest.fn().mockResolvedValue(undefined) }
  const mail = {
    send: jest.fn<Promise<void>, [{ notificationId: string }]>().mockResolvedValue(undefined),
  }
  const payments = { charge: jest.fn() }
  const workflow = new IntegratedCheckout({
    ...fixture,
    reservations,
    inventory,
    mail,
    payments,
    pricing: { priceOf: () => Promise.resolve(null) },
    ids: { generate: () => 'unused' },
    recipient: { resolve: () => Promise.resolve('unused@example.invalid') },
    clock: { now: () => new Date(time) },
  })
  return {
    workflow,
    reservations,
    inventory,
    mail,
    payments,
    now: () => new Date(time),
    advance: () => {
      time += RECOVERY_RETRY_DELAY_MS
    },
  }
}

/** The same behavioral checks exercise both adapters, including real PostgreSQL. */
export const recoveryContract = (getFixture: () => RecoveryFixture): void => {
  it('el pedido51 avanza pese a50 fallos; difiere reintentos sin ocultar pendientes', async () => {
    const fixture = getFixture()
    const attempts: PurchaseAttempt[] = []
    for (let i = 0; i < 51; i++) attempts.push(await seedAttempt(fixture, i))
    const h = workflowFixture(fixture)
    const blocked = new Set(attempts.slice(0, 50).map((attempt) => attempt.id))
    h.reservations.reserve.mockImplementation(({ reservationId }) =>
      blocked.has(reservationId)
        ? Promise.reject(new IntegrationUnavailableError('Destino no disponible'))
        : Promise.resolve(),
    )
    expect(await fixture.store.pending()).toHaveLength(51)
    expect(await fixture.store.dueAttempts(h.now())).toHaveLength(50)
    await h.workflow.recover()
    expect(await fixture.store.pending()).toHaveLength(51)
    expect((await fixture.store.dueAttempts(h.now())).map((a) => a.id)).toEqual([attempts[50]!.id])
    await h.workflow.recover()
    expect((await fixture.store.findByOrder(attempts[50]!.orderId))!.state).toBe('COMPLETED')
    expect(await fixture.store.pending()).toHaveLength(50)
    expect(await fixture.store.dueAttempts(h.now())).toEqual([])
    expect(h.reservations.reserve).toHaveBeenCalledTimes(51)
    await h.workflow.recover()
    expect(h.reservations.reserve).toHaveBeenCalledTimes(51)
    h.advance()
    await h.workflow.recover()
    expect(h.reservations.reserve).toHaveBeenCalledTimes(101)
    expect(h.inventory.grant).toHaveBeenCalledTimes(1)
    expect(h.payments.charge).not.toHaveBeenCalled()
  })

  it('el correo51 avanza pese a50 fallos y los otros siguen visibles hasta vencimiento', async () => {
    const fixture = getFixture()
    const attempts: PurchaseAttempt[] = []
    for (let i = 0; i < 51; i++) {
      const attempt = await seedAttempt(fixture, i)
      await fixture.store.advance(attempt.id, 'RESERVING', 'RESERVED')
      await fixture.store.advance(attempt.id, 'RESERVED', 'DELIVERED')
      await fixture.store.complete(attempt)
      attempts.push(attempt)
    }
    const h = workflowFixture(fixture)
    const blocked = new Set(attempts.slice(0, 50).map((attempt) => attempt.id))
    h.mail.send.mockImplementation(({ notificationId }) =>
      blocked.has(notificationId)
        ? Promise.reject(new IntegrationUnavailableError('Correo pendiente'))
        : Promise.resolve(),
    )
    await h.workflow.recover()
    expect(await fixture.store.pendingMail()).toHaveLength(51)
    expect((await fixture.store.dueMail(h.now())).map((n) => n.notificationId)).toEqual([
      attempts[50]!.id,
    ])
    await h.workflow.recover()
    expect(await fixture.store.pendingMail()).toHaveLength(50)
    expect(await fixture.store.dueMail(h.now())).toEqual([])
    expect(h.mail.send).toHaveBeenCalledTimes(51)
    await h.workflow.recover()
    expect(h.mail.send).toHaveBeenCalledTimes(51)
    h.advance()
    await h.workflow.recover()
    expect(h.mail.send).toHaveBeenCalledTimes(101)
    expect(h.inventory.grant).not.toHaveBeenCalled()
    expect(h.payments.charge).not.toHaveBeenCalled()
  })

  it('el reintento directo reanuda inmediatamente una compra diferida sin cobrar de nuevo', async () => {
    const fixture = getFixture()
    const attempt = await seedAttempt(fixture, 0)
    const h = workflowFixture(fixture)
    h.reservations.reserve.mockRejectedValueOnce(new IntegrationUnavailableError('Timeout'))
    await h.workflow.recover()
    expect(await fixture.store.dueAttempts(h.now())).toEqual([])
    const result = await h.workflow.execute({
      orderId: attempt.orderId,
      card: { holder: 'Persona', number: '1234', expiry: 'texto', securityCode: 'texto' },
    })
    expect(result.status).toBe('COMPLETED')
    expect(result.paymentReference).toBe(attempt.paymentReference)
    expect(await fixture.store.pending()).toEqual([])
    expect(h.reservations.reserve).toHaveBeenCalledTimes(2)
    expect(h.inventory.grant).toHaveBeenCalledTimes(1)
    expect(h.payments.charge).not.toHaveBeenCalled()
  })

  it('un fallo inesperado no aborta los siguientes pedidos ni sus notificaciones', async () => {
    const fixture = getFixture()
    const first = await seedAttempt(fixture, 0)
    const second = await seedAttempt(fixture, 1)
    const h = workflowFixture(fixture)
    h.reservations.reserve.mockRejectedValueOnce(
      new Error('Error independiente de la primera entrada'),
    )
    await expect(h.workflow.recover()).rejects.toThrow('Error independiente')
    expect((await fixture.store.findByOrder(first.orderId))!.state).toBe('RESERVING')
    expect((await fixture.store.findByOrder(second.orderId))!.state).toBe('COMPLETED')
    expect(await fixture.store.dueAttempts(h.now())).toEqual([])
    expect(h.mail.send).toHaveBeenCalledTimes(1)
    expect(await fixture.store.pendingMail()).toEqual([])
  })
}
