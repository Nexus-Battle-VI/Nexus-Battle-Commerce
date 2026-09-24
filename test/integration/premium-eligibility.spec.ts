import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { HttpCatalogPricing } from '../../src/adapters/outbound/pricing/HttpCatalogPricing'
import {
  AddOrderLine,
  ChangeOrderLineQuantity,
  GetOrCreateCart,
} from '../../src/application/use-cases/OrderUseCases'
import { RestoreSavedCart, SaveCart } from '../../src/application/use-cases/SavedCartUseCases'
import { InMemoryOrderRepository } from '../../src/adapters/outbound/persistence/InMemoryOrderRepository'
import { InMemorySavedCartRepository } from '../../src/adapters/outbound/persistence/InMemorySavedCartRepository'
import { ProductNotPurchasableError } from '../../src/application/errors/ApplicationError'

const productId = '33333333-3333-4333-8333-333333333333'

const baseProduct = {
  productId,
  sku: 'objeto-legendario',
  name: 'Objeto legendario',
  imageUrl: 'https://example.com/x.png',
  premium: true,
  lifecycleStatus: 'ACTIVE',
  availableUnits: 10,
  realMoneyPrice: { amount: 5_000, currency: 'COP' },
}

const sequence = (prefix: string): (() => string) => {
  let counter = 0

  return (): string => {
    counter += 1

    return `${prefix}-${String(counter)}`
  }
}

/**
 * Elegibilidad de comercializacion premium.
 *
 * Fuente funcional: PDF "Proyecto Integrador II" S7.2.2 y la seccion
 * "Elegibilidad de comercializacion premium" de Infrastructure
 * `docs/contracts/ecommerce-integration-v1.md`. La autoridad de esta regla
 * vive en Commerce, no en Catalog ni en Web: reutiliza el campo `type` que
 * `HttpCatalogPricing.productOf()` ya recibe de la misma respuesta de
 * Catalog -sin campo derivado (`ecommerceEligible`) ni endpoint nuevo-.
 *
 * Estas pruebas ejercitan el caso de uso completo (no solo el adaptador HTTP
 * en aislamiento) contra un servidor Catalog real de pruebas, para demostrar
 * que un intento directo de `AddOrderLine`/`ChangeOrderLineQuantity`/
 * `RestoreSavedCart` con `type: ITEM` o `type: EPICA` se rechaza aunque el
 * producto tenga `premium: true` y `realMoneyPrice`, sin depender de que Web
 * los oculte.
 */
describe('Elegibilidad de comercializacion premium (autoridad en Commerce)', () => {
  let server: Server
  let baseUrl: string
  let response: { status: number; body: unknown }

  beforeAll(async () => {
    server = createServer((_request, reply) => {
      reply.writeHead(response.status, { 'content-type': 'application/json' })
      reply.end(JSON.stringify(response.body))
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
  })

  beforeEach(() => {
    response = { status: 200, body: { ...baseProduct, type: 'ARMA' } }
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve()
      })
    })
  })

  const harness = () => {
    const orders = new InMemoryOrderRepository()
    const savedCarts = new InMemorySavedCartRepository()
    const pricing = new HttpCatalogPricing(baseUrl, 500)
    const ids = { generate: sequence('ord') }
    const clock = { now: (): Date => new Date('2026-09-24T10:00:00.000Z') }
    const orderDeps = { orders, pricing, clock, ids }
    const savedDeps = { savedCarts, orders, pricing, ids }

    return {
      orders,
      savedCarts,
      openCart: new GetOrCreateCart(orderDeps),
      add: new AddOrderLine(orderDeps),
      change: new ChangeOrderLineQuantity(orderDeps),
      save: new SaveCart(savedDeps),
      restore: new RestoreSavedCart(savedDeps),
    }
  }

  describe.each(['ITEM', 'EPICA'])('type=%s (fuera de E-commerce)', (type) => {
    it('AddOrderLine rechaza el producto con ProductNotPurchasableError aunque premium=true y tenga realMoneyPrice', async () => {
      response = { status: 200, body: { ...baseProduct, type } }
      const h = harness()
      const cart = await h.openCart.execute('acc-1', 'COP')

      await expect(
        h.add.execute({ orderId: cart.id, productId, quantity: 1 }),
      ).rejects.toBeInstanceOf(ProductNotPurchasableError)

      const untouched = await h.openCart.execute('acc-1', 'COP')
      expect(untouched.id).toBe(cart.id)
      expect(untouched.itemCount).toBe(0)
    })
  })

  it.each(['HEROE', 'HABILIDAD', 'ARMA', 'ARMADURA'])(
    'AddOrderLine acepta type=%s cuando cumple el resto de condiciones',
    async (type) => {
      response = { status: 200, body: { ...baseProduct, type } }
      const h = harness()
      const cart = await h.openCart.execute('acc-1', 'COP')

      const order = await h.add.execute({ orderId: cart.id, productId, quantity: 1 })

      expect(order.lines).toHaveLength(1)
      expect(order.total).toBe(5_000)
    },
  )

  it('ChangeOrderLineQuantity hereda el mismo rechazo cuando Catalog cambia el tipo a ITEM tras agregar la linea', async () => {
    const h = harness()
    const cart = await h.openCart.execute('acc-1', 'COP')
    await h.add.execute({ orderId: cart.id, productId, quantity: 1 })

    // Catalog reclasifica el producto (o se descubre que nunca debio ser
    // elegible): un cambio de cantidad vuelve a consultar el precio vigente.
    response = { status: 200, body: { ...baseProduct, type: 'ITEM' } }

    await expect(
      h.change.execute({ orderId: cart.id, productId, quantity: 2 }),
    ).rejects.toBeInstanceOf(ProductNotPurchasableError)
  })

  it('RestoreSavedCart hereda el mismo rechazo via requirePrice cuando Catalog cambia el tipo a EPICA', async () => {
    const h = harness()
    const cart = await h.openCart.execute('acc-1', 'COP')
    await h.add.execute({ orderId: cart.id, productId, quantity: 1 })
    await h.save.execute('acc-1')

    response = { status: 200, body: { ...baseProduct, type: 'EPICA' } }

    await expect(h.restore.execute('acc-1')).rejects.toBeInstanceOf(ProductNotPurchasableError)
  })

  it('flujo premium en COP de extremo a extremo: alta, cambio de cantidad y total autoritativo de Catalog', async () => {
    response = { status: 200, body: { ...baseProduct, type: 'ARMA' } }
    const h = harness()
    const cart = await h.openCart.execute('acc-1', 'COP')

    const afterAdd = await h.add.execute({ orderId: cart.id, productId, quantity: 2 })
    expect(afterAdd.currency).toBe('COP')
    expect(afterAdd.total).toBe(10_000)
    expect(afterAdd.lines).toEqual([
      expect.objectContaining({ productId, unitPrice: 5_000, quantity: 2, subtotal: 10_000 }),
    ])

    const afterChange = await h.change.execute({ orderId: cart.id, productId, quantity: 3 })
    expect(afterChange.currency).toBe('COP')
    expect(afterChange.total).toBe(15_000)
  })

  /**
   * La regla de elegibilidad no limita el sistema a COP (contrato,
   * "Moneda"): USD y EUR ya funcionan para el resto del flujo y este trabajo
   * no debe romperlos.
   */
  it('no restringe monedas distintas de COP: USD sigue funcionando para un producto elegible', async () => {
    response = {
      status: 200,
      body: { ...baseProduct, type: 'ARMA', realMoneyPrice: { amount: 500, currency: 'USD' } },
    }
    const h = harness()
    const cart = await h.openCart.execute('acc-1', 'USD')

    const order = await h.add.execute({ orderId: cart.id, productId, quantity: 1 })

    expect(order.currency).toBe('USD')
    expect(order.total).toBe(500)
  })
})
