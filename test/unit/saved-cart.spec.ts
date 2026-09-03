import {
  AddOrderLine,
  CancelOrder,
  GetCart,
  GetOrCreateCart,
} from '../../src/application/use-cases/OrderUseCases'
import {
  DiscardSavedCart,
  GetSavedCart,
  RestoreSavedCart,
  SaveCart,
} from '../../src/application/use-cases/SavedCartUseCases'
import { InMemoryOrderRepository } from '../../src/adapters/outbound/persistence/InMemoryOrderRepository'
import { InMemorySavedCartRepository } from '../../src/adapters/outbound/persistence/InMemorySavedCartRepository'
import {
  DEMO_PRICES,
  LocalCatalogPricing,
} from '../../src/adapters/outbound/pricing/LocalCatalogPricing'
import { SavedCart } from '../../src/domain/entities/SavedCart'
import { CustomerId } from '../../src/domain/value-objects/commerce-values'
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
  const savedCarts = new InMemorySavedCartRepository()
  const ids = { generate: sequence('ord') }
  const orderDeps = {
    orders,
    pricing: new LocalCatalogPricing(DEMO_PRICES),
    clock: { now: (): Date => FIXED_NOW },
    ids,
  }
  const savedDeps = { savedCarts, orders, ids }

  return {
    orders,
    savedCarts,
    openCart: new GetOrCreateCart(orderDeps),
    add: new AddOrderLine(orderDeps),
    cancel: new CancelOrder(orderDeps),
    getCart: new GetCart(orders),
    save: new SaveCart(savedDeps),
    read: new GetSavedCart(savedCarts),
    restore: new RestoreSavedCart(savedDeps),
    discard: new DiscardSavedCart(savedCarts),
  }
}

/** Deja a `customer` con un carrito que contiene espada x2 y pocion x1. */
const cartWithTwoLines = async (
  harness: ReturnType<typeof buildHarness>,
  customer: string,
): Promise<string> => {
  const cart = await harness.openCart.execute(customer, 'COP')
  await harness.add.execute({ orderId: cart.id, sku: 'espada-de-hierro', quantity: 2 })
  await harness.add.execute({ orderId: cart.id, sku: 'pocion-de-vida', quantity: 1 })

  return cart.id
}

describe('SavedCart', () => {
  const snapshot = {
    customerId: 'acc-1',
    currency: 'COP',
    lines: [{ sku: 'espada-de-hierro', unitPriceAmount: 15_000, quantity: 2 }],
  }

  it('congela el contenido de un pedido', () => {
    const saved = SavedCart.fromOrder(snapshot)

    expect(saved.size).toBe(1)
    expect(saved.currency).toBe('COP')
    expect(saved.owner.value).toBe('acc-1')
  })

  it('rechaza guardar un carrito sin lineas', () => {
    expect(() => SavedCart.fromOrder({ ...snapshot, lines: [] })).toThrow(DomainError)
  })

  it('rechaza reconstituir un carrito guardado sin lineas', () => {
    expect(() => SavedCart.restore({ customerId: 'acc-1', currency: 'COP', items: [] })).toThrow(
      DomainError,
    )
  })

  it('reconoce a su dueno y solo a el', () => {
    const saved = SavedCart.fromOrder(snapshot)

    expect(saved.belongsTo(CustomerId.create('acc-1'))).toBe(true)
    expect(saved.belongsTo(CustomerId.create('acc-2'))).toBe(false)
  })

  it('la instantanea preserva referencias, precios y cantidades', () => {
    expect(SavedCart.fromOrder(snapshot).toSnapshot()).toEqual({
      customerId: 'acc-1',
      currency: 'COP',
      items: [{ sku: 'espada-de-hierro', unitPriceAmount: 15_000, quantity: 2 }],
    })
  })
})

describe('SaveCart', () => {
  it('guarda el contenido vigente con sus precios y totales', async () => {
    const harness = buildHarness()
    await cartWithTwoLines(harness, 'acc-1')

    const saved = await harness.save.execute('acc-1')

    expect(saved.items).toHaveLength(2)
    expect(saved.itemCount).toBe(3)
    // 2 x 15.000 + 1 x 2.000
    expect(saved.total).toBe(32_000)
  })

  it('rechaza guardar cuando el cliente no tiene carrito', async () => {
    await expect(buildHarness().save.execute('acc-sin-carrito')).rejects.toBeInstanceOf(DomainError)
  })

  it('rechaza guardar un carrito abierto pero vacio', async () => {
    const harness = buildHarness()
    await harness.openCart.execute('acc-1', 'COP')

    await expect(harness.save.execute('acc-1')).rejects.toBeInstanceOf(DomainError)
  })

  /** Un solo carrito guardado por cliente: guardar de nuevo reemplaza. */
  it('reemplaza lo guardado antes en lugar de acumular', async () => {
    const harness = buildHarness()
    const cartId = await cartWithTwoLines(harness, 'acc-1')
    await harness.save.execute('acc-1')

    await harness.add.execute({ orderId: cartId, sku: 'arco-corto', quantity: 1 })
    const second = await harness.save.execute('acc-1')

    expect(second.items).toHaveLength(3)
    expect(harness.savedCarts.size).toBe(1)
  })

  it('el carrito guardado no cambia si despues cambia el carrito vivo', async () => {
    const harness = buildHarness()
    const cartId = await cartWithTwoLines(harness, 'acc-1')
    await harness.save.execute('acc-1')

    await harness.add.execute({ orderId: cartId, sku: 'arco-corto', quantity: 1 })

    expect((await harness.read.execute('acc-1'))?.items).toHaveLength(2)
  })
})

describe('GetSavedCart', () => {
  it('devuelve null cuando el cliente nunca guardo nada', async () => {
    expect(await buildHarness().read.execute('acc-1')).toBeNull()
  })

  /** CP-61-02: el carrito de A jamas se presenta como carrito de B. */
  it('no devuelve el carrito guardado de otro cliente', async () => {
    const harness = buildHarness()
    await cartWithTwoLines(harness, 'acc-a')
    await harness.save.execute('acc-a')

    expect(await harness.read.execute('acc-b')).toBeNull()
  })
})

describe('RestoreSavedCart', () => {
  /** Recuperacion sobre un borrador nuevo; la identidad entre sesiones se verifica en HTTP. */
  it('recupera los productos guardados en un carrito nuevo', async () => {
    const harness = buildHarness()
    const original = await cartWithTwoLines(harness, 'acc-1')
    await harness.save.execute('acc-1')

    // Se cancela el borrador vigente; la copia guardada sigue disponible.
    await harness.cancel.execute(original, 'Cerrar borrador para recuperar guardado')
    expect(await harness.getCart.execute('acc-1')).toBeNull()

    const recovered = await harness.restore.execute('acc-1')

    expect(recovered.id).not.toBe(original)
    expect(recovered.lines).toHaveLength(2)
    expect(recovered.itemCount).toBe(3)
    expect(recovered.total).toBe(32_000)
  })

  it('reemplaza el contenido del carrito vigente en lugar de fusionarlo', async () => {
    const harness = buildHarness()
    await cartWithTwoLines(harness, 'acc-1')
    await harness.save.execute('acc-1')

    // Otra sesion deja algo suelto en el carrito.
    const current = await harness.openCart.execute('acc-1', 'COP')
    await harness.add.execute({ orderId: current.id, sku: 'arco-corto', quantity: 4 })

    const recovered = await harness.restore.execute('acc-1')

    expect(recovered.lines.map((line) => line.sku).sort()).toEqual([
      'espada-de-hierro',
      'pocion-de-vida',
    ])
    expect(recovered.itemCount).toBe(3)
  })

  it('conserva el precio guardado con el adaptador local', async () => {
    const harness = buildHarness()
    await cartWithTwoLines(harness, 'acc-1')
    await harness.save.execute('acc-1')

    const recovered = await harness.restore.execute('acc-1')
    const sword = recovered.lines.find((line) => line.sku === 'espada-de-hierro')

    expect(sword?.unitPrice).toBe(15_000)
    expect(sword?.subtotal).toBe(30_000)
  })

  it('falla cuando el cliente no tiene nada guardado', async () => {
    await expect(buildHarness().restore.execute('acc-1')).rejects.toBeInstanceOf(DomainError)
  })

  /** CP-61-02 en la recuperacion: B no hereda lo que guardo A. */
  it('no recupera el carrito guardado por otro cliente', async () => {
    const harness = buildHarness()
    await cartWithTwoLines(harness, 'acc-a')
    await harness.save.execute('acc-a')

    await expect(harness.restore.execute('acc-b')).rejects.toBeInstanceOf(DomainError)
  })

  it('es repetible: recuperar dos veces deja el mismo contenido', async () => {
    const harness = buildHarness()
    await cartWithTwoLines(harness, 'acc-1')
    await harness.save.execute('acc-1')

    await harness.restore.execute('acc-1')
    const second = await harness.restore.execute('acc-1')

    expect(second.lines).toHaveLength(2)
    expect(second.itemCount).toBe(3)
  })
})

describe('DiscardSavedCart', () => {
  it('descarta lo guardado', async () => {
    const harness = buildHarness()
    await cartWithTwoLines(harness, 'acc-1')
    await harness.save.execute('acc-1')

    await harness.discard.execute('acc-1')

    expect(await harness.read.execute('acc-1')).toBeNull()
  })

  it('descartar lo que no existe no falla', async () => {
    await expect(buildHarness().discard.execute('acc-1')).resolves.toBeUndefined()
  })
})

describe('InMemorySavedCartRepository', () => {
  /** Guarda instantaneas: mutar el agregado despues no altera lo guardado. */
  it('no conserva referencias vivas al agregado', async () => {
    const repository = new InMemorySavedCartRepository()
    const cart = SavedCart.fromOrder({
      customerId: 'acc-1',
      currency: 'COP',
      lines: [{ sku: 'espada-de-hierro', unitPriceAmount: 15_000, quantity: 1 }],
    })

    await repository.save(cart)
    const first = await repository.findByCustomer(CustomerId.create('acc-1'))
    const second = await repository.findByCustomer(CustomerId.create('acc-1'))

    expect(first).not.toBe(second)
    expect(first?.toSnapshot()).toEqual(second?.toSnapshot())
  })
})
