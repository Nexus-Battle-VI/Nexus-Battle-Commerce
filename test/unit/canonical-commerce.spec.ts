import {
  AddOrderLine,
  ChangeOrderLineQuantity,
  ConfirmOrder,
  GetCart,
  GetOrCreateCart,
  RemoveOrderLine,
} from '../../src/application/use-cases/OrderUseCases'
import {
  AddToWishlist,
  GetWishlistItemStatus,
  ListWishlist,
  RemoveFromWishlist,
} from '../../src/application/use-cases/WishlistUseCases'
import { RestoreSavedCart, SaveCart } from '../../src/application/use-cases/SavedCartUseCases'
import { InMemoryOrderRepository } from '../../src/adapters/outbound/persistence/InMemoryOrderRepository'
import { InMemoryWishlistRepository } from '../../src/adapters/outbound/persistence/InMemoryWishlistRepository'
import { InMemorySavedCartRepository } from '../../src/adapters/outbound/persistence/InMemorySavedCartRepository'
import { CheckoutConflictError } from '../../src/application/ports/CommerceIntegrationPorts'
import { ProductNotPurchasableError } from '../../src/application/errors/ApplicationError'
import type {
  CatalogProduct,
  ProductPricingPort,
} from '../../src/application/ports/ProductPricingPort'
import type { OrderRepositoryPort } from '../../src/application/ports/OrderRepositoryPort'
import {
  CustomerId,
  Money,
  OrderId,
  Quantity,
  Sku,
} from '../../src/domain/value-objects/commerce-values'
import { Order } from '../../src/domain/entities/Order'
import { Wishlist } from '../../src/domain/entities/Wishlist'
import { SavedCart } from '../../src/domain/entities/SavedCart'

const PRODUCT_ID = '72a3f0e1-78ad-4d1c-a641-e328529c4b41'
const SECOND_ID = '72a3f0e1-78ad-4d1c-a641-e328529c4b42'
const customer = CustomerId.create('customer-a')
const NOW = new Date('2026-09-03T12:00:00Z')
const initial: CatalogProduct = {
  productId: PRODUCT_ID,
  sku: 'espada-real',
  name: 'Espada real',
  imageUrl: '/api/v1/catalog/assets/image',
  premium: true,
  lifecycleStatus: 'ACTIVE',
  availableUnits: 4,
  realMoneyPrice: { amount: 15000, currency: 'COP' },
}
const harness = () => {
  const products = new Map<string, CatalogProduct>([[PRODUCT_ID, { ...initial }]])
  const pricing: ProductPricingPort = {
    productOf: (reference) =>
      Promise.resolve(
        [...products.values()].find((p) => [p.productId, p.sku].includes(reference)) ?? null,
      ),
    priceOf: (reference) => {
      const product = [...products.values()].find((p) => [p.productId, p.sku].includes(reference))
      if (
        product?.lifecycleStatus !== 'ACTIVE' ||
        !product.premium ||
        product.realMoneyPrice === null
      )
        return Promise.resolve(null)
      return Promise.resolve({
        productId: product.productId,
        sku: product.sku,
        name: product.name,
        imageUrl: product.imageUrl,
        availableUnits: product.availableUnits,
        ...product.realMoneyPrice,
      })
    },
  }
  const orders = new InMemoryOrderRepository()
  const wishlist = new InMemoryWishlistRepository()
  const savedCarts = new InMemorySavedCartRepository()
  const purchased = new Set<string>()
  const purchases = {
    wasPurchased: jest.fn((owner: string, productId: string) =>
      Promise.resolve(purchased.has(`${owner}:${productId}`)),
    ),
  }
  let sequence = 0
  const deps = {
    orders,
    pricing,
    ids: { generate: () => `order-${String(++sequence)}` },
    clock: { now: () => NOW },
  }
  const wishDeps = { wishlist, orders, pricing, purchases }
  const savedDeps = { ...deps, savedCarts }
  return {
    products,
    pricing,
    orders,
    wishlist,
    savedCarts,
    purchased,
    purchases,
    deps,
    savedDeps,
    open: new GetOrCreateCart(deps),
    get: new GetCart(orders),
    add: new AddOrderLine(deps),
    change: new ChangeOrderLineQuantity(deps),
    remove: new RemoveOrderLine(deps),
    confirm: new ConfirmOrder(deps),
    wish: new AddToWishlist(wishDeps),
    unwish: new RemoveFromWishlist(wishDeps),
    status: new GetWishlistItemStatus(wishDeps),
    list: new ListWishlist(wishDeps),
    save: new SaveCart(savedDeps),
    restore: new RestoreSavedCart(savedDeps),
  }
}
const cartWithProduct = async (h: ReturnType<typeof harness>, quantity = 1) => {
  const cart = await h.open.execute(customer.value, 'COP')
  return h.add.execute({ orderId: cart.id, productId: PRODUCT_ID, quantity })
}

describe('Carrito con Catalog canonico', () => {
  it('persiste UUID y metadatos, admite SKU legacy y combina ambas referencias sin duplicarlas', async () => {
    const h = harness()
    const cart = await h.open.execute(customer.value, 'COP')
    const legacy = (await h.orders.findById(OrderId.create(cart.id)))!
    legacy.addLine(Sku.create(initial.sku), Money.create(15000, 'COP'), Quantity.create(1))
    await h.orders.save(legacy)
    const added = await h.add.execute({ orderId: cart.id, productId: PRODUCT_ID, quantity: 2 })
    expect(added.lines).toEqual([
      {
        productId: PRODUCT_ID,
        sku: initial.sku,
        name: initial.name,
        imageUrl: initial.imageUrl,
        unitPrice: 15000,
        quantity: 3,
        subtotal: 45000,
      },
    ])
    expect((await h.orders.findById(OrderId.create(cart.id)))!.toSnapshot().lines[0]!.sku).toBe(
      PRODUCT_ID,
    )
    const changed = await h.change.execute({ orderId: cart.id, sku: initial.sku, quantity: 2 })
    expect(changed.itemCount).toBe(2)
    expect((await h.remove.execute(cart.id, initial.sku)).itemCount).toBe(0)
  })
  it('compara stock con la cantidad acumulada y rechaza cambios sin alterar lo guardado', async () => {
    const h = harness()
    const cart = await cartWithProduct(h, 3)
    await expect(
      h.add.execute({ orderId: cart.id, productId: PRODUCT_ID, quantity: 2 }),
    ).rejects.toBeInstanceOf(CheckoutConflictError)
    await expect(
      h.change.execute({ orderId: cart.id, productId: PRODUCT_ID, quantity: 5 }),
    ).rejects.toBeInstanceOf(CheckoutConflictError)
    expect((await h.get.execute(customer.value))!.itemCount).toBe(3)
  })
  it('no cambia silenciosamente un precio pactado al reanadir o editar cantidades', async () => {
    const h = harness()
    const cart = await cartWithProduct(h)
    h.products.set(PRODUCT_ID, { ...initial, realMoneyPrice: { amount: 16000, currency: 'COP' } })
    await expect(
      h.add.execute({ orderId: cart.id, productId: PRODUCT_ID, quantity: 1 }),
    ).rejects.toBeInstanceOf(CheckoutConflictError)
    await expect(
      h.change.execute({ orderId: cart.id, productId: PRODUCT_ID, quantity: 2 }),
    ).rejects.toBeInstanceOf(CheckoutConflictError)
    expect((await h.get.execute(customer.value))!.total).toBe(15000)
  })
  it('rechaza moneda ajena y un producto suspendido', async () => {
    const h = harness()
    const cart = await h.open.execute(customer.value, 'USD')
    await expect(
      h.add.execute({ orderId: cart.id, productId: PRODUCT_ID, quantity: 1 }),
    ).rejects.toBeInstanceOf(CheckoutConflictError)
    h.products.set(PRODUCT_ID, { ...initial, lifecycleStatus: 'SUSPENDED' })
    await expect(
      h.add.execute({ orderId: cart.id, productId: PRODUCT_ID, quantity: 1 }),
    ).rejects.toBeInstanceOf(ProductNotPurchasableError)
    expect((await h.get.execute(customer.value))!.itemCount).toBe(0)
  })
  it('mantiene PROCESSING como carrito vigente, bloquea ediciones y confirmacion directa', async () => {
    const h = harness()
    const cart = await cartWithProduct(h)
    const processing = (await h.orders.findById(OrderId.create(cart.id)))!
    processing.beginCheckout()
    await h.orders.save(processing)
    expect((await h.get.execute(customer.value))!.status).toBe('PROCESSING')
    expect((await h.open.execute(customer.value, 'COP')).id).toBe(cart.id)
    expect(h.orders.size).toBe(1)
    await expect(
      h.add.execute({ orderId: cart.id, productId: PRODUCT_ID, quantity: 1 }),
    ).rejects.toBeInstanceOf(CheckoutConflictError)
    await expect(
      h.change.execute({ orderId: cart.id, productId: PRODUCT_ID, quantity: 2 }),
    ).rejects.toBeInstanceOf(CheckoutConflictError)
    await expect(h.remove.execute(cart.id, PRODUCT_ID)).rejects.toBeInstanceOf(
      CheckoutConflictError,
    )
    await expect(h.confirm.execute(cart.id)).rejects.toBeInstanceOf(CheckoutConflictError)
  })
  it('cambia moneda solo si esta vacio', async () => {
    const h = harness()
    const first = await h.open.execute(customer.value, 'USD')
    expect(await h.open.execute(customer.value, 'COP')).toMatchObject({
      id: first.id,
      currency: 'COP',
    })
    await h.add.execute({ orderId: first.id, productId: PRODUCT_ID, quantity: 1 })
    await expect(h.open.execute(customer.value, 'EUR')).rejects.toBeInstanceOf(
      CheckoutConflictError,
    )
    expect((await h.get.execute(customer.value))!.currency).toBe('COP')
  })
  it('relee el ganador de una creacion concurrente 23505 sin borrar ordenes', async () => {
    const h = harness()
    const winner = Order.draft({
      id: OrderId.create('winner'),
      customerId: customer,
      currency: 'COP',
    })
    const findByCustomer = jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([winner])
    const save = jest.fn().mockRejectedValue({ code: '23505' })
    const orders: OrderRepositoryPort = {
      findById: () => Promise.resolve(null),
      findByCustomer,
      save,
    }
    const result = await new GetOrCreateCart({ ...h.deps, orders }).execute(customer.value, 'COP')
    expect(result.id).toBe('winner')
    expect(save).toHaveBeenCalledTimes(1)
  })
})

describe('Deseos y adquirido canonicos', () => {
  it('marca adquirido aunque el producto nunca haya estado en deseos', async () => {
    const h = harness()
    h.purchased.add(`${customer.value}:${PRODUCT_ID}`)
    expect(await h.status.execute(customer.value, initial.sku)).toEqual({
      productId: PRODUCT_ID,
      sku: initial.sku,
      enDeseos: false,
      adquirido: true,
    })
    expect(h.purchases.wasPurchased).toHaveBeenCalledWith(customer.value, PRODUCT_ID)
  })
  it('un pedido confirmado historico no equivale a una compra completada en el store', async () => {
    const h = harness()
    const cart = await cartWithProduct(h)
    const order = (await h.orders.findById(OrderId.create(cart.id)))!
    order.confirm(NOW)
    await h.orders.save(order)
    expect((await h.status.execute(customer.value, PRODUCT_ID)).adquirido).toBe(false)
  })
  it('migra deseos SKU a UUID, elimina ambos alias y no pierde altas concurrentes distintas', async () => {
    const h = harness()
    const legacy = Wishlist.empty(customer)
    legacy.add(Sku.create(initial.sku))
    await h.wishlist.save(legacy)
    h.products.set(SECOND_ID, { ...initial, productId: SECOND_ID, sku: 'escudo-real' })
    await Promise.all([
      h.wish.execute(customer.value, PRODUCT_ID),
      h.wish.execute(customer.value, SECOND_ID),
    ])
    const items = await h.list.execute(customer.value)
    expect(items).toHaveLength(2)
    expect([...(await h.wishlist.findByCustomer(customer))!.toSnapshot().skus].sort()).toEqual([
      PRODUCT_ID,
      SECOND_ID,
    ])
    await h.unwish.execute(customer.value, initial.sku)
    expect((await h.status.execute(customer.value, PRODUCT_ID)).enDeseos).toBe(false)
    expect(await h.list.execute(customer.value)).toHaveLength(1)
  })
  it('rechaza productos inexistentes o suspendidos sin persistir un deseo', async () => {
    const h = harness()
    await expect(h.wish.execute(customer.value, SECOND_ID)).rejects.toBeInstanceOf(
      ProductNotPurchasableError,
    )
    h.products.set(PRODUCT_ID, { ...initial, lifecycleStatus: 'SUSPENDED' })
    await expect(h.wish.execute(customer.value, PRODUCT_ID)).rejects.toBeInstanceOf(
      ProductNotPurchasableError,
    )
    expect(await h.wishlist.findByCustomer(customer)).toBeNull()
  })
})

describe('Restauracion validada del carrito', () => {
  it('rechaza un fallo al final del lote y suma stock de alias duplicados antes de tocar el borrador', async () => {
    const h = harness()
    await cartWithProduct(h)
    const before = await h.get.execute(customer.value)
    await h.savedCarts.save(
      SavedCart.restore({
        customerId: customer.value,
        currency: 'COP',
        items: [
          { sku: initial.sku, unitPriceAmount: 15000, quantity: 2 },
          { sku: SECOND_ID, unitPriceAmount: 15000, quantity: 1 },
        ],
      }),
    )
    await expect(h.restore.execute(customer.value)).rejects.toBeInstanceOf(
      ProductNotPurchasableError,
    )
    expect(await h.get.execute(customer.value)).toEqual(before)
    await h.savedCarts.save(
      SavedCart.restore({
        customerId: customer.value,
        currency: 'COP',
        items: [
          { sku: initial.sku, unitPriceAmount: 15000, quantity: 3 },
          { sku: PRODUCT_ID, unitPriceAmount: 15000, quantity: 3 },
        ],
      }),
    )
    await expect(h.restore.execute(customer.value)).rejects.toBeInstanceOf(CheckoutConflictError)
    expect(await h.get.execute(customer.value)).toEqual(before)
  })
  it('revalida todo el lote antes de modificar el borrador y conserva la copia ante un fallo', async () => {
    const h = harness()
    await cartWithProduct(h, 2)
    await h.save.execute(customer.value)
    const before = await h.get.execute(customer.value)
    h.products.set(PRODUCT_ID, { ...initial, availableUnits: 1 })
    await expect(h.restore.execute(customer.value)).rejects.toBeInstanceOf(CheckoutConflictError)
    expect(await h.get.execute(customer.value)).toEqual(before)
    expect((await h.savedCarts.findByCustomer(customer))!.lines[0]!.quantity.value).toBe(2)
    h.products.set(PRODUCT_ID, { ...initial, realMoneyPrice: { amount: 17000, currency: 'COP' } })
    await expect(h.restore.execute(customer.value)).rejects.toBeInstanceOf(CheckoutConflictError)
    expect(await h.get.execute(customer.value)).toEqual(before)
  })
  it('restaura SKU legacy como UUID y cambia moneda despues de vaciar el contenido anterior', async () => {
    const h = harness()
    await h.savedCarts.save(
      SavedCart.restore({
        customerId: customer.value,
        currency: 'COP',
        items: [{ sku: initial.sku, unitPriceAmount: 15000, quantity: 2 }],
      }),
    )
    const current = await h.open.execute(customer.value, 'USD')
    const legacy = (await h.orders.findById(OrderId.create(current.id)))!
    legacy.addLine(Sku.create('old-usd'), Money.create(100, 'USD'), Quantity.create(1))
    await h.orders.save(legacy)
    const result = await h.restore.execute(customer.value)
    expect(result).toMatchObject({ id: current.id, currency: 'COP', total: 30000, itemCount: 2 })
    expect(result.lines).toHaveLength(1)
    expect(result.lines[0]).toMatchObject({
      productId: PRODUCT_ID,
      sku: initial.sku,
      name: initial.name,
    })
  })
  it('no guarda ni reemplaza una compra PROCESSING', async () => {
    const h = harness()
    const cart = await cartWithProduct(h)
    await h.save.execute(customer.value)
    const processing = (await h.orders.findById(OrderId.create(cart.id)))!
    processing.beginCheckout()
    await h.orders.save(processing)
    await expect(h.save.execute(customer.value)).rejects.toBeInstanceOf(CheckoutConflictError)
    await expect(h.restore.execute(customer.value)).rejects.toBeInstanceOf(CheckoutConflictError)
    expect((await h.get.execute(customer.value))!.status).toBe('PROCESSING')
    expect(h.orders.size).toBe(1)
  })
})
