import { randomUUID } from 'node:crypto'
import {
  IntegratedCheckout,
  RECOVERY_RETRY_DELAY_MS,
  type IntegratedCheckoutDependencies,
} from '../../src/application/use-cases/IntegratedCheckout'
import { InMemoryPurchaseStore } from '../../src/adapters/outbound/persistence/InMemoryPurchaseStore'
import { InMemoryOrderRepository } from '../../src/adapters/outbound/persistence/InMemoryOrderRepository'
import { SimulatedPaymentGateway } from '../../src/adapters/outbound/payment/SimulatedPaymentGateway'
import { AddOrderLine, GetOrCreateCart } from '../../src/application/use-cases/OrderUseCases'
import { PaymentDeclinedError } from '../../src/application/use-cases/CheckoutUseCases'
import {
  CheckoutConflictError,
  IntegrationRejectedError,
  IntegrationUnavailableError,
  type ReservationCommand,
  type InventoryGrantPort,
  type PurchaseNotification,
} from '../../src/application/ports/CommerceIntegrationPorts'
import type { ProductPrice } from '../../src/application/ports/ProductPricingPort'
import { OrderId } from '../../src/domain/value-objects/commerce-values'

const productId = '11111111-1111-4111-8111-111111111111'
const card = {
  holder: 'Ana Gomez',
  number: '4111111111111111',
  expiry: '12/30',
  securityCode: '123',
}
const product: ProductPrice = {
  productId,
  sku: 'espada',
  name: 'Espada',
  imageUrl: 'https://example.com/a.png',
  amount: 2500,
  currency: 'COP',
  availableUnits: 10,
}
const unavailable = (): IntegrationUnavailableError =>
  new IntegrationUnavailableError('timeout incierto')

const harness = async () => {
  const orders = new InMemoryOrderRepository()
  const store = new InMemoryPurchaseStore(orders)
  const pricing = {
    priceOf: jest.fn<Promise<ProductPrice | null>, [string]>().mockResolvedValue(product),
  }
  const ids = { generate: randomUUID }
  const common = {
    orders,
    pricing,
    ids,
    clock: { now: (): Date => new Date('2026-09-03T12:00:00Z') },
  }
  const openCart = new GetOrCreateCart(common)
  const addLine = new AddOrderLine(common)
  const cart = await openCart.execute('player-a', 'COP')
  await addLine.execute({ orderId: cart.id, productId, quantity: 2 })
  const reservations = {
    reserve: jest.fn<Promise<void>, [ReservationCommand]>().mockResolvedValue(undefined),
    confirm: jest.fn<Promise<void>, [string, string]>().mockResolvedValue(undefined),
    release: jest.fn<Promise<void>, [string, string]>().mockResolvedValue(undefined),
  }
  const applied = new Set<string>()
  const inventory = {
    grant: jest
      .fn<Promise<void>, [Parameters<InventoryGrantPort['grant']>[0]]>()
      .mockImplementation((command) => {
        applied.add(command.operationId)
        return Promise.resolve()
      }),
  }
  const recipient = {
    resolve: jest
      .fn<Promise<string>, [string, string]>()
      .mockResolvedValue('registered@example.com'),
  }
  const mail = {
    send: jest.fn<Promise<void>, [PurchaseNotification]>().mockResolvedValue(undefined),
  }
  const payments = new SimulatedPaymentGateway()
  const dependencies: IntegratedCheckoutDependencies = {
    orders,
    store,
    pricing,
    ids,
    reservations,
    inventory,
    recipient,
    mail,
    payments,
  }
  const workflow = new IntegratedCheckout(dependencies)
  const command = { orderId: cart.id, card, accessToken: 'authenticated-token' }
  return {
    orders,
    store,
    pricing,
    reservations,
    inventory,
    applied,
    recipient,
    mail,
    payments,
    workflow,
    command,
    dependencies,
    openCart,
    addLine,
  }
}

describe('Coordinacion recuperable de compras', () => {
  it('congela precio aceptado, completa pedido+outbox y nunca persiste tarjeta ni token', async () => {
    const h = await harness()
    h.pricing.priceOf.mockResolvedValue({ ...product, amount: 9999 })
    const result = await h.workflow.execute(h.command)
    expect(result.status).toBe('COMPLETED')
    expect(result.order.total).toBe(5000)
    expect(result.order.status).toBe('CONFIRMED')
    expect(h.recipient.resolve).toHaveBeenCalledWith('player-a', 'authenticated-token')
    const attempt = (await h.store.findByOrder(h.command.orderId))!
    expect(h.reservations.reserve).toHaveBeenCalledWith({
      reservationId: attempt.id,
      playerId: 'player-a',
      lines: [{ productId, quantity: 2 }],
    })
    expect(h.inventory.grant).toHaveBeenCalledWith({
      operationId: attempt.id,
      playerId: 'player-a',
      items: [{ productId, quantity: 2 }],
    })
    expect(h.reservations.confirm).toHaveBeenCalledWith(attempt.id, 'player-a')
    expect(await h.store.wasPurchased('player-a', productId)).toBe(true)
    expect(await h.store.wasPurchased('player-b', productId)).toBe(false)
    expect(await h.store.pendingMail()).toEqual([
      expect.objectContaining({
        recipient: 'registered@example.com',
        total: 5000,
        items: [expect.objectContaining({ productId, unitPrice: 2500, quantity: 2 })],
      }),
    ])
    const serialized = JSON.stringify(attempt)
    expect(serialized).not.toContain(card.number)
    expect(serialized).not.toContain('securityCode')
    expect(serialized).not.toContain(h.command.accessToken)
    expect(h.mail.send).not.toHaveBeenCalled()
    await h.workflow.recover()
    expect(h.mail.send).toHaveBeenCalledTimes(1)
    expect(await h.store.pendingMail()).toEqual([])
  })

  it('replay completado conserva referencia y otra compra usa otra operacion', async () => {
    const h = await harness()
    const first = await h.workflow.execute(h.command)
    expect(await new IntegratedCheckout(h.dependencies).execute(h.command)).toEqual(first)
    expect(h.inventory.grant).toHaveBeenCalledTimes(1)
    const next = await h.openCart.execute('player-a', 'COP')
    expect(next.id).not.toBe(h.command.orderId)
    expect(next.itemCount).toBe(0)
    await h.addLine.execute({ orderId: next.id, productId, quantity: 1 })
    const second = await h.workflow.execute({ ...h.command, orderId: next.id })
    expect(second.paymentReference).not.toBe(first.paymentReference)
    expect(h.applied.size).toBe(2)
  })

  it('rechazo terminal de stock no concede inventario y permite un intento nuevo', async () => {
    const h = await harness()
    h.reservations.reserve.mockRejectedValueOnce(new IntegrationRejectedError('stock insuficiente'))
    await expect(h.workflow.execute(h.command)).rejects.toBeInstanceOf(IntegrationRejectedError)
    const failed = (await h.store.findByOrder(h.command.orderId))!
    expect(failed.state).toBe('FAILED')
    expect((await h.orders.findById(OrderId.create(h.command.orderId)))?.isEditable).toBe(true)
    expect(h.inventory.grant).not.toHaveBeenCalled()
    expect(h.reservations.release).not.toHaveBeenCalled()
    expect(await h.store.pendingMail()).toEqual([])
    expect((await h.workflow.execute(h.command)).status).toBe('COMPLETED')
    expect((await h.store.findByOrder(h.command.orderId))?.id).not.toBe(failed.id)
  })

  it('una reserva incierta queda pendiente y GET status no produce efectos', async () => {
    const h = await harness()
    h.reservations.reserve.mockRejectedValueOnce(unavailable())
    expect((await h.workflow.execute(h.command)).status).toBe('PROCESSING')
    const first = (await h.store.findByOrder(h.command.orderId))!
    expect(first.state).toBe('RESERVING')
    await h.workflow.status(h.command.orderId)
    expect(h.reservations.reserve).toHaveBeenCalledTimes(1)
    expect(h.inventory.grant).not.toHaveBeenCalled()
    expect(h.reservations.release).not.toHaveBeenCalled()
    await new IntegratedCheckout(h.dependencies).recover()
    expect(h.reservations.reserve.mock.calls[1]?.[0].reservationId).toBe(first.id)
    expect((await h.workflow.status(h.command.orderId)).status).toBe('COMPLETED')
  })

  it('timeout despues de entregar conserva RESERVED y recupera el mismo grant sin duplicar', async () => {
    const h = await harness()
    h.inventory.grant.mockImplementationOnce((command) => {
      h.applied.add(command.operationId)
      return Promise.reject(unavailable())
    })
    expect((await h.workflow.execute(h.command)).status).toBe('PROCESSING')
    const first = (await h.store.findByOrder(h.command.orderId))!
    expect(first.state).toBe('RESERVED')
    expect(h.reservations.release).not.toHaveBeenCalled()
    expect(h.reservations.confirm).not.toHaveBeenCalled()
    await new IntegratedCheckout(h.dependencies).recover()
    expect(h.inventory.grant.mock.calls.map(([request]) => request.operationId)).toEqual([
      first.id,
      first.id,
    ])
    expect(h.applied.size).toBe(1)
    expect((await h.workflow.status(h.command.orderId)).status).toBe('COMPLETED')
  })

  it('rechazo terminal del inventario libera la reserva antes de devolver DRAFT', async () => {
    const h = await harness()
    h.inventory.grant.mockRejectedValueOnce(new IntegrationRejectedError('inventario completo'))
    h.reservations.release.mockRejectedValueOnce(unavailable())
    expect((await h.workflow.execute(h.command)).status).toBe('PROCESSING')
    expect((await h.store.findByOrder(h.command.orderId))?.state).toBe('RELEASING')
    expect((await h.orders.findById(OrderId.create(h.command.orderId)))?.isEditable).toBe(false)
    await new IntegratedCheckout(h.dependencies).recover()
    expect((await h.store.findByOrder(h.command.orderId))?.state).toBe('FAILED')
    expect((await h.orders.findById(OrderId.create(h.command.orderId)))?.isEditable).toBe(true)
    expect(h.reservations.release).toHaveBeenCalledTimes(2)
    expect(h.reservations.confirm).not.toHaveBeenCalled()
    expect(h.applied.size).toBe(0)
    expect(await h.store.pendingMail()).toEqual([])
    await expect(h.workflow.status(h.command.orderId)).rejects.toBeInstanceOf(
      IntegrationRejectedError,
    )
  })

  it('confirmacion incierta conserva DELIVERED; recuperacion no vuelve a entregar', async () => {
    const h = await harness()
    h.reservations.confirm.mockRejectedValueOnce(unavailable())
    expect((await h.workflow.execute(h.command)).status).toBe('PROCESSING')
    expect((await h.store.findByOrder(h.command.orderId))?.state).toBe('DELIVERED')
    await h.workflow.recover()
    expect(h.inventory.grant).toHaveBeenCalledTimes(1)
    expect(h.reservations.confirm).toHaveBeenCalledTimes(2)
    expect(h.reservations.release).not.toHaveBeenCalled()
    expect((await h.workflow.status(h.command.orderId)).status).toBe('COMPLETED')
  })

  it('correo no disponible conserva outbox; reintento no repite reserva ni entrega', async () => {
    const h = await harness()
    await h.workflow.execute(h.command)
    let time = Date.now() + 1000
    const recovery = new IntegratedCheckout({
      ...h.dependencies,
      clock: { now: () => new Date(time) },
    })
    h.mail.send.mockRejectedValueOnce(unavailable())
    await recovery.recover()
    expect(await h.store.pendingMail()).toHaveLength(1)
    await recovery.recover()
    expect(h.mail.send).toHaveBeenCalledTimes(1)
    time += RECOVERY_RETRY_DELAY_MS
    await recovery.recover()
    expect(await h.store.pendingMail()).toHaveLength(0)
    expect(h.inventory.grant).toHaveBeenCalledTimes(1)
    expect(h.reservations.reserve).toHaveBeenCalledTimes(1)
    expect(h.mail.send.mock.calls[0]?.[0]).toEqual(h.mail.send.mock.calls[1]?.[0])
  })

  it('solicitudes concurrentes convergen en una operacion y un correo', async () => {
    const h = await harness()
    const results = await Promise.all(
      Array.from({ length: 8 }, () => h.workflow.execute(h.command)),
    )
    expect(results.every((result) => result.status === 'COMPLETED')).toBe(true)
    expect(new Set(results.map((result) => result.paymentReference)).size).toBe(1)
    expect(h.applied.size).toBe(1)
    expect(new Set(h.inventory.grant.mock.calls.map(([request]) => request.operationId)).size).toBe(
      1,
    )
    expect(await h.store.pendingMail()).toHaveLength(1)
  })

  it('rechaza version antigua, correo no resuelto y productos no disponibles antes de iniciar', async () => {
    const h = await harness()
    await expect(h.workflow.execute({ ...h.command, expectedVersion: 0 })).rejects.toBeInstanceOf(
      CheckoutConflictError,
    )
    h.pricing.priceOf.mockResolvedValueOnce(null)
    await expect(h.workflow.execute(h.command)).rejects.toBeInstanceOf(IntegrationRejectedError)
    h.pricing.priceOf.mockResolvedValueOnce({ ...product, currency: 'USD' })
    await expect(h.workflow.execute(h.command)).rejects.toBeInstanceOf(IntegrationRejectedError)
    h.pricing.priceOf.mockResolvedValueOnce({ ...product, availableUnits: 1 })
    await expect(h.workflow.execute(h.command)).rejects.toBeInstanceOf(IntegrationRejectedError)
    h.recipient.resolve.mockRejectedValueOnce(unavailable())
    await expect(h.workflow.execute(h.command)).rejects.toBeInstanceOf(IntegrationUnavailableError)
    await expect(
      h.workflow.execute({ ...h.command, card: { ...card, number: '4111111111110000' } }),
    ).rejects.toBeInstanceOf(PaymentDeclinedError)
    expect(await h.store.findByOrder(h.command.orderId)).toBeNull()
    expect(h.inventory.grant).not.toHaveBeenCalled()
    expect(h.reservations.reserve).not.toHaveBeenCalled()
  })

  it('fallo de escritura tras entrega se recupera desde el estado durable', async () => {
    const h = await harness()
    const original = h.store.advance.bind(h.store)
    const advance = jest.spyOn(h.store, 'advance')
    advance.mockImplementationOnce(original).mockRejectedValueOnce(new Error('DB no disponible'))
    await expect(h.workflow.execute(h.command)).rejects.toThrow('DB no disponible')
    expect((await h.store.findByOrder(h.command.orderId))?.state).toBe('RESERVED')
    advance.mockRestore()
    await new IntegratedCheckout(h.dependencies).recover()
    expect(h.applied.size).toBe(1)
    expect((await h.workflow.status(h.command.orderId)).status).toBe('COMPLETED')
  })
})
