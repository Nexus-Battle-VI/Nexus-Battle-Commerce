import {
  AddOrderLine,
  ChangeOrderLineQuantity,
  CreateOrder,
  GetCart,
  GetOrCreateCart,
  RemoveOrderLine,
} from '../../src/application/use-cases/OrderUseCases'
import { OrderNotFoundError } from '../../src/application/errors/ApplicationError'
import { InMemoryOrderRepository } from '../../src/adapters/outbound/persistence/InMemoryOrderRepository'
import {
  DEMO_PRICES,
  LocalCatalogPricing,
} from '../../src/adapters/outbound/pricing/LocalCatalogPricing'
import { Order, OrderStatus } from '../../src/domain/entities/Order'
import {
  CustomerId,
  Money,
  OrderId,
  Quantity,
  Sku,
} from '../../src/domain/value-objects/commerce-values'
import { DomainError } from '../../src/domain/errors/DomainError'

const FIXED_NOW = new Date('2026-08-31T10:00:00.000Z')

const sequence = (prefix: string): (() => string) => {
  let counter = 0

  return (): string => {
    counter += 1

    return `${prefix}-${String(counter)}`
  }
}

const buildHarness = () => {
  const orders = new InMemoryOrderRepository()
  const deps = {
    orders,
    pricing: new LocalCatalogPricing(DEMO_PRICES),
    clock: { now: (): Date => FIXED_NOW },
    ids: { generate: sequence('ord') },
  }

  return {
    orders,
    create: new CreateOrder(deps),
    add: new AddOrderLine(deps),
    remove: new RemoveOrderLine(deps),
    changeQuantity: new ChangeOrderLineQuantity(deps),
    getCart: new GetCart(orders),
    openCart: new GetOrCreateCart(deps),
  }
}

describe('Order.itemCount', () => {
  const buildOrder = (): Order =>
    Order.draft({
      id: OrderId.create('ord-1'),
      customerId: CustomerId.create('acc-1'),
      currency: 'COP',
    })

  it('es cero en un pedido vacio', () => {
    expect(buildOrder().itemCount).toBe(0)
  })

  it('suma las cantidades, no las referencias', () => {
    const order = buildOrder()
    order.addLine(Sku.create('espada-de-hierro'), Money.create(15_000, 'COP'), Quantity.create(2))
    order.addLine(Sku.create('pocion-de-vida'), Money.create(2_000, 'COP'), Quantity.create(3))

    expect(order.lineCount).toBe(2)
    expect(order.itemCount).toBe(5)
  })

  it('viaja en la instantanea', () => {
    const order = buildOrder()
    order.addLine(Sku.create('espada-de-hierro'), Money.create(15_000, 'COP'), Quantity.create(4))

    expect(order.toSnapshot().itemCount).toBe(4)
  })
})

describe('Order.changeLineQuantity', () => {
  const orderWithSword = (): Order => {
    const order = Order.draft({
      id: OrderId.create('ord-1'),
      customerId: CustomerId.create('acc-1'),
      currency: 'COP',
    })
    order.addLine(Sku.create('espada-de-hierro'), Money.create(15_000, 'COP'), Quantity.create(2))

    return order
  }

  it('fija la cantidad exacta en lugar de acumularla', () => {
    const order = orderWithSword()

    order.changeLineQuantity(Sku.create('espada-de-hierro'), Quantity.create(5))

    expect(order.quantityOf(Sku.create('espada-de-hierro'))).toBe(5)
    expect(order.total.amount).toBe(75_000)
  })

  it('permite reducir la cantidad', () => {
    const order = orderWithSword()

    order.changeLineQuantity(Sku.create('espada-de-hierro'), Quantity.create(1))

    expect(order.itemCount).toBe(1)
    expect(order.total.amount).toBe(15_000)
  })

  it('conserva el precio pactado al anadir la linea', () => {
    const order = orderWithSword()

    order.changeLineQuantity(Sku.create('espada-de-hierro'), Quantity.create(3))

    expect(order.toSnapshot().lines[0]?.unitPriceAmount).toBe(15_000)
  })

  it('rechaza una referencia que no esta en el pedido', () => {
    const order = orderWithSword()

    expect(() => {
      order.changeLineQuantity(Sku.create('pocion-de-vida'), Quantity.create(1))
    }).toThrow(DomainError)
  })

  it('rechaza el cambio sobre un pedido confirmado', () => {
    const order = orderWithSword()
    order.confirm(FIXED_NOW)

    expect(() => {
      order.changeLineQuantity(Sku.create('espada-de-hierro'), Quantity.create(1))
    }).toThrow(DomainError)
  })

  it('rechaza el cambio sobre un pedido cancelado', () => {
    const order = orderWithSword()
    order.cancel('Sin existencias', FIXED_NOW)

    expect(() => {
      order.changeLineQuantity(Sku.create('espada-de-hierro'), Quantity.create(1))
    }).toThrow(DomainError)
  })
})

describe('ChangeOrderLineQuantity', () => {
  it('recalcula subtotal y total, y lo persiste', async () => {
    const harness = buildHarness()
    const order = await harness.create.execute({ customerId: 'acc-1', currency: 'COP' })
    await harness.add.execute({ orderId: order.id, sku: 'espada-de-hierro', quantity: 1 })

    const result = await harness.changeQuantity.execute({
      orderId: order.id,
      sku: 'espada-de-hierro',
      quantity: 3,
    })

    expect(result.lines[0]).toEqual({
      sku: 'espada-de-hierro',
      unitPrice: 15_000,
      quantity: 3,
      subtotal: 45_000,
    })
    expect(result.total).toBe(45_000)
    expect(result.itemCount).toBe(3)
    // Se relee del repositorio para confirmar que quedo guardado.
    expect((await harness.getCart.execute('acc-1'))?.total).toBe(45_000)
  })

  it('falla con un pedido inexistente y con una cantidad invalida', async () => {
    const harness = buildHarness()
    const order = await harness.create.execute({ customerId: 'acc-1', currency: 'COP' })
    await harness.add.execute({ orderId: order.id, sku: 'espada-de-hierro', quantity: 1 })

    await expect(
      harness.changeQuantity.execute({
        orderId: 'inexistente',
        sku: 'espada-de-hierro',
        quantity: 1,
      }),
    ).rejects.toBeInstanceOf(OrderNotFoundError)
    await expect(
      harness.changeQuantity.execute({ orderId: order.id, sku: 'espada-de-hierro', quantity: 0 }),
    ).rejects.toBeInstanceOf(DomainError)
  })
})

describe('GetCart', () => {
  it('devuelve null cuando el cliente no tiene ningun carrito', async () => {
    expect(await buildHarness().getCart.execute('acc-sin-carrito')).toBeNull()
  })

  it('devuelve el borrador vigente del cliente', async () => {
    const harness = buildHarness()
    await harness.create.execute({ customerId: 'acc-1', currency: 'COP' })

    const cart = await harness.getCart.execute('acc-1')

    expect(cart?.status).toBe(OrderStatus.Draft)
    expect(cart?.itemCount).toBe(0)
  })

  /**
   * Un pedido confirmado dejo de ser el carrito: es una compra. Si `GetCart`
   * lo devolviera, la interfaz mostraria como carrito algo que ya no admite
   * cambios.
   */
  it('no devuelve un pedido confirmado como carrito', async () => {
    const harness = buildHarness()
    const order = await harness.create.execute({ customerId: 'acc-1', currency: 'COP' })
    await harness.add.execute({ orderId: order.id, sku: 'espada-de-hierro', quantity: 1 })
    const completed = (await harness.orders.findById(OrderId.create(order.id)))!
    completed.beginCheckout()
    completed.completeCheckout(FIXED_NOW)
    await harness.orders.save(completed)

    expect(await harness.getCart.execute('acc-1')).toBeNull()
  })

  it('no devuelve el carrito de otro cliente', async () => {
    const harness = buildHarness()
    await harness.create.execute({ customerId: 'acc-1', currency: 'COP' })

    expect(await harness.getCart.execute('acc-2')).toBeNull()
  })
})

describe('GetOrCreateCart', () => {
  it('abre un carrito cuando el cliente no tenia ninguno', async () => {
    const harness = buildHarness()

    const cart = await harness.openCart.execute('acc-1', 'COP')

    expect(cart.status).toBe(OrderStatus.Draft)
    expect(cart.customerId).toBe('acc-1')
    expect(harness.orders.size).toBe(1)
  })

  it('es idempotente: no abre un segundo carrito', async () => {
    const harness = buildHarness()

    const first = await harness.openCart.execute('acc-1', 'COP')
    const second = await harness.openCart.execute('acc-1', 'COP')

    expect(second.id).toBe(first.id)
    expect(harness.orders.size).toBe(1)
  })

  it('conserva el contenido del carrito ya abierto', async () => {
    const harness = buildHarness()
    const cart = await harness.openCart.execute('acc-1', 'COP')
    await harness.add.execute({ orderId: cart.id, sku: 'espada-de-hierro', quantity: 2 })

    const reopened = await harness.openCart.execute('acc-1', 'COP')

    expect(reopened.itemCount).toBe(2)
    expect(reopened.total).toBe(30_000)
  })

  /**
   * Tras confirmar la compra, el siguiente carrito es uno nuevo y vacio: el
   * pedido confirmado ya no admite lineas.
   */
  it('abre un carrito nuevo despues de confirmar el anterior', async () => {
    const harness = buildHarness()
    const cart = await harness.openCart.execute('acc-1', 'COP')
    await harness.add.execute({ orderId: cart.id, sku: 'espada-de-hierro', quantity: 1 })
    const completed = (await harness.orders.findById(OrderId.create(cart.id)))!
    completed.beginCheckout()
    completed.completeCheckout(FIXED_NOW)
    await harness.orders.save(completed)

    const next = await harness.openCart.execute('acc-1', 'COP')

    expect(next.id).not.toBe(cart.id)
    expect(next.itemCount).toBe(0)
  })

  it('rechaza una moneda no soportada y un cliente vacio', async () => {
    const harness = buildHarness()

    await expect(harness.openCart.execute('acc-1', 'GBP')).rejects.toBeInstanceOf(DomainError)
    await expect(harness.openCart.execute('  ', 'COP')).rejects.toBeInstanceOf(DomainError)
  })
})

describe('Conciliacion del carrito tras agregar, cambiar y eliminar', () => {
  it('el total siempre corresponde al contenido vigente', async () => {
    const harness = buildHarness()
    const cart = await harness.openCart.execute('acc-1', 'COP')

    await harness.add.execute({ orderId: cart.id, sku: 'espada-de-hierro', quantity: 1 })
    await harness.add.execute({ orderId: cart.id, sku: 'pocion-de-vida', quantity: 2 })
    // 15.000 + 2 x 2.000
    expect((await harness.getCart.execute('acc-1'))?.total).toBe(19_000)

    await harness.changeQuantity.execute({
      orderId: cart.id,
      sku: 'pocion-de-vida',
      quantity: 5,
    })
    // 15.000 + 5 x 2.000
    expect((await harness.getCart.execute('acc-1'))?.total).toBe(25_000)

    await harness.remove.execute(cart.id, 'espada-de-hierro')
    const final = await harness.getCart.execute('acc-1')

    expect(final?.total).toBe(10_000)
    expect(final?.itemCount).toBe(5)
    expect(final?.lines).toHaveLength(1)
  })
})
