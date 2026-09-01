import {
  CheckoutOrder,
  PaymentDeclinedError,
} from '../../src/application/use-cases/CheckoutUseCases'
import { AddOrderLine, GetOrCreateCart } from '../../src/application/use-cases/OrderUseCases'
import { InMemoryOrderRepository } from '../../src/adapters/outbound/persistence/InMemoryOrderRepository'
import { InMemoryPlayerInventory } from '../../src/adapters/outbound/inventory/InMemoryPlayerInventory'
import { InMemoryEventPublisher } from '../../src/adapters/outbound/messaging/InMemoryEventPublisher'
import { SimulatedPaymentGateway } from '../../src/adapters/outbound/payment/SimulatedPaymentGateway'
import {
  DEMO_PRICES,
  LocalCatalogPricing,
} from '../../src/adapters/outbound/pricing/LocalCatalogPricing'
import { Order } from '../../src/domain/entities/Order'
import type { OrderConfirmed } from '../../src/domain/events/OrderEvents'
import {
  CustomerId,
  Money,
  OrderId,
  Quantity,
  Sku,
} from '../../src/domain/value-objects/commerce-values'

const FIXED_NOW = new Date('2026-09-01T10:00:00.000Z')
const CONFIRMED = 'commerce.order.confirmed'

const VALID_CARD = {
  holder: 'Ana Gomez',
  number: '4111111111111111',
  expiry: '12/30',
  securityCode: '123',
}
const DECLINED_CARD = { ...VALID_CARD, number: '4111111111110000' }

const sequence = (prefix: string): (() => string) => {
  let counter = 0

  return (): string => {
    counter += 1

    return `${prefix}-${String(counter)}`
  }
}

const buildHarness = () => {
  const orders = new InMemoryOrderRepository()
  const clock = { now: (): Date => FIXED_NOW }
  const ids = { generate: sequence('ord') }
  const events = new InMemoryEventPublisher()
  const inventory = new InMemoryPlayerInventory()
  const orderDeps = { orders, pricing: new LocalCatalogPricing(DEMO_PRICES), clock, ids }

  return {
    events,
    openCart: new GetOrCreateCart(orderDeps),
    add: new AddOrderLine(orderDeps),
    checkout: new CheckoutOrder({
      orders,
      payments: new SimulatedPaymentGateway(),
      inventory,
      clock,
      events,
    }),
  }
}

const cartReadyToPay = async (harness: ReturnType<typeof buildHarness>): Promise<string> => {
  const cart = await harness.openCart.execute('acc-1', 'COP')
  await harness.add.execute({ orderId: cart.id, sku: 'espada-de-hierro', quantity: 2 })
  await harness.add.execute({ orderId: cart.id, sku: 'pocion-de-vida', quantity: 1 })

  return cart.id
}

describe('El evento de compra confirmada lleva lo que el correo necesita', () => {
  const buildConfirmedOrder = (): Order => {
    const order = Order.draft({
      id: OrderId.create('ord-1'),
      customerId: CustomerId.create('acc-1'),
      currency: 'COP',
    })
    order.addLine(Sku.create('espada-de-hierro'), Money.create(15_000, 'COP'), Quantity.create(2))
    order.addLine(Sku.create('pocion-de-vida'), Money.create(2_000, 'COP'), Quantity.create(1))
    order.confirm(FIXED_NOW)

    return order
  }

  it('incluye el detalle de cada producto adquirido', () => {
    const [event] = buildConfirmedOrder().pullEvents() as OrderConfirmed[]

    expect(event?.lines).toEqual([
      { sku: 'espada-de-hierro', quantity: 2, unitPriceAmount: 15_000, subtotalAmount: 30_000 },
      { sku: 'pocion-de-vida', quantity: 1, unitPriceAmount: 2_000, subtotalAmount: 2_000 },
    ])
  })

  it('incluye el total pagado y el cliente al que dirigir el correo', () => {
    const [event] = buildConfirmedOrder().pullEvents() as OrderConfirmed[]

    expect(event?.totalAmount).toBe(32_000)
    expect(event?.currency).toBe('COP')
    expect(event?.customerId).toBe('acc-1')
    expect(event?.aggregateId).toBe('ord-1')
  })

  it('el recuento de lineas sigue coincidiendo con el detalle', () => {
    const [event] = buildConfirmedOrder().pullEvents() as OrderConfirmed[]

    expect(event?.lineCount).toBe(event?.lines.length)
  })

  /** El total del evento cuadra con la suma de sus propios subtotales. */
  it('el total del evento concilia con sus lineas', () => {
    const [event] = buildConfirmedOrder().pullEvents() as OrderConfirmed[]
    const sum = (event?.lines ?? []).reduce((total, line) => total + line.subtotalAmount, 0)

    expect(sum).toBe(event?.totalAmount)
  })
})

describe('Publicacion de la confirmacion de compra', () => {
  /** CP-60-01: compra completada produce exactamente una confirmacion. */
  it('publica un evento de compra confirmada al completar la compra', async () => {
    const harness = buildHarness()
    const cartId = await cartReadyToPay(harness)

    await harness.checkout.execute({ orderId: cartId, card: VALID_CARD })

    const published = harness.events.publishedOf(CONFIRMED) as OrderConfirmed[]

    expect(published).toHaveLength(1)
    expect(published[0]?.aggregateId).toBe(cartId)
    expect(published[0]?.totalAmount).toBe(32_000)
    expect(published[0]?.lines).toHaveLength(2)
  })

  /** CP-60-02: una transaccion no completada no genera confirmacion. */
  it('un pago rechazado no publica ninguna confirmacion', async () => {
    const harness = buildHarness()
    const cartId = await cartReadyToPay(harness)

    await expect(
      harness.checkout.execute({ orderId: cartId, card: DECLINED_CARD }),
    ).rejects.toBeInstanceOf(PaymentDeclinedError)

    expect(harness.events.publishedOf(CONFIRMED)).toHaveLength(0)
  })

  it('un carrito vacio no publica ninguna confirmacion', async () => {
    const harness = buildHarness()
    const cart = await harness.openCart.execute('acc-1', 'COP')

    await expect(harness.checkout.execute({ orderId: cart.id, card: VALID_CARD })).rejects.toThrow()

    expect(harness.events.published).toHaveLength(0)
  })

  /**
   * Un pedido no puede confirmarse dos veces, asi que tampoco puede haber dos
   * correos para la misma compra.
   */
  it('pagar dos veces no publica una segunda confirmacion', async () => {
    const harness = buildHarness()
    const cartId = await cartReadyToPay(harness)
    await harness.checkout.execute({ orderId: cartId, card: VALID_CARD })

    await expect(harness.checkout.execute({ orderId: cartId, card: VALID_CARD })).rejects.toThrow()

    expect(harness.events.publishedOf(CONFIRMED)).toHaveLength(1)
  })

  it('dos compras distintas publican una confirmacion cada una', async () => {
    const harness = buildHarness()

    const first = await cartReadyToPay(harness)
    await harness.checkout.execute({ orderId: first, card: VALID_CARD })
    const second = await cartReadyToPay(harness)
    await harness.checkout.execute({ orderId: second, card: VALID_CARD })

    const published = harness.events.publishedOf(CONFIRMED)

    expect(published).toHaveLength(2)
    expect(published.map((event) => event.aggregateId)).toEqual([first, second])
  })

  it('el detalle publicado corresponde a esa compra y no a otra', async () => {
    const harness = buildHarness()
    const first = await cartReadyToPay(harness)
    await harness.checkout.execute({ orderId: first, card: VALID_CARD })

    const cart = await harness.openCart.execute('acc-1', 'COP')
    await harness.add.execute({ orderId: cart.id, sku: 'arco-corto', quantity: 1 })
    await harness.checkout.execute({ orderId: cart.id, card: VALID_CARD })

    const published = harness.events.publishedOf(CONFIRMED) as OrderConfirmed[]

    expect(published[1]?.lines).toEqual([
      { sku: 'arco-corto', quantity: 1, unitPriceAmount: 12_000, subtotalAmount: 12_000 },
    ])
    expect(published[1]?.totalAmount).toBe(12_000)
  })
})

describe('InMemoryEventPublisher', () => {
  it('conserva los eventos publicados en orden', async () => {
    const publisher = new InMemoryEventPublisher()

    await publisher.publish([
      { name: 'a', aggregateId: 'x', occurredAt: FIXED_NOW },
      { name: 'b', aggregateId: 'y', occurredAt: FIXED_NOW },
    ])

    expect(publisher.published.map((event) => event.name)).toEqual(['a', 'b'])
  })

  it('filtra por nombre de evento', async () => {
    const publisher = new InMemoryEventPublisher()

    await publisher.publish([
      { name: 'a', aggregateId: 'x', occurredAt: FIXED_NOW },
      { name: 'b', aggregateId: 'y', occurredAt: FIXED_NOW },
    ])

    expect(publisher.publishedOf('a')).toHaveLength(1)
    expect(publisher.publishedOf('sin-eventos')).toHaveLength(0)
  })

  it('publicar una lista vacia no registra nada', async () => {
    const publisher = new InMemoryEventPublisher()

    await publisher.publish([])

    expect(publisher.published).toHaveLength(0)
  })
})
