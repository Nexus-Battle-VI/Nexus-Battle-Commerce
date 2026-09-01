import {
  CheckoutOrder,
  GetCheckoutSummary,
  PaymentDeclinedError,
} from '../../src/application/use-cases/CheckoutUseCases'
import {
  AddOrderLine,
  GetCart,
  GetOrCreateCart,
} from '../../src/application/use-cases/OrderUseCases'
import { OrderNotFoundError } from '../../src/application/errors/ApplicationError'
import { InMemoryOrderRepository } from '../../src/adapters/outbound/persistence/InMemoryOrderRepository'
import { InMemoryPlayerInventory } from '../../src/adapters/outbound/inventory/InMemoryPlayerInventory'
import { SimulatedPaymentGateway } from '../../src/adapters/outbound/payment/SimulatedPaymentGateway'
import {
  DEMO_PRICES,
  LocalCatalogPricing,
} from '../../src/adapters/outbound/pricing/LocalCatalogPricing'
import type { PlayerInventoryPort } from '../../src/application/ports/PlayerInventoryPort'
import { DomainError } from '../../src/domain/errors/DomainError'
import { OrderStatus } from '../../src/domain/entities/Order'

const FIXED_NOW = new Date('2026-09-01T10:00:00.000Z')

const VALID_CARD = {
  holder: 'Ana Gomez',
  number: '4111111111111111',
  expiry: '12/30',
  securityCode: '123',
}

/** Termina en 0000: la pasarela simulada la rechaza. */
const DECLINED_CARD = { ...VALID_CARD, number: '4111111111110000' }

const sequence = (prefix: string): (() => string) => {
  let counter = 0

  return (): string => {
    counter += 1

    return `${prefix}-${String(counter)}`
  }
}

const buildHarness = (inventory: PlayerInventoryPort = new InMemoryPlayerInventory()) => {
  const orders = new InMemoryOrderRepository()
  const clock = { now: (): Date => FIXED_NOW }
  const orderDeps = {
    orders,
    pricing: new LocalCatalogPricing(DEMO_PRICES),
    clock,
    ids: sequence('ord'),
  }

  return {
    orders,
    inventory,
    openCart: new GetOrCreateCart({ ...orderDeps, ids: { generate: orderDeps.ids } }),
    add: new AddOrderLine({ ...orderDeps, ids: { generate: orderDeps.ids } }),
    getCart: new GetCart(orders),
    summary: new GetCheckoutSummary(orders),
    checkout: new CheckoutOrder({
      orders,
      payments: new SimulatedPaymentGateway(),
      inventory,
      clock,
    }),
  }
}

/** Deja al cliente con espada x2 (30.000) y pocion x1 (2.000) = 32.000. */
const cartReadyToPay = async (
  harness: ReturnType<typeof buildHarness>,
  customer = 'acc-1',
): Promise<string> => {
  const cart = await harness.openCart.execute(customer, 'COP')
  await harness.add.execute({ orderId: cart.id, sku: 'espada-de-hierro', quantity: 2 })
  await harness.add.execute({ orderId: cart.id, sku: 'pocion-de-vida', quantity: 1 })

  return cart.id
}

describe('SimulatedPaymentGateway', () => {
  const request = {
    transactionId: 'ord-1',
    amount: 32_000,
    currency: 'COP',
    card: VALID_CARD,
  }

  it('aprueba una tarjeta corriente y devuelve referencia', async () => {
    const outcome = await new SimulatedPaymentGateway().charge(request)

    expect(outcome.approved).toBe(true)
    expect(outcome.reference).toBe('sim-ord-1')
  })

  it('nunca devuelve el numero completo, solo los cuatro ultimos digitos', async () => {
    const outcome = await new SimulatedPaymentGateway().charge(request)

    expect(outcome.maskedCard).toBe('1111')
    expect(JSON.stringify(outcome)).not.toContain('4111111111111111')
  })

  it('rechaza la tarjeta reservada para el camino de rechazo', async () => {
    const outcome = await new SimulatedPaymentGateway().charge({
      ...request,
      card: DECLINED_CARD,
    })

    expect(outcome.approved).toBe(false)
    expect(outcome.reference).toBeNull()
    expect(outcome.declineReason).not.toBeNull()
  })

  it('rechaza un importe que no es positivo', async () => {
    const outcome = await new SimulatedPaymentGateway().charge({ ...request, amount: 0 })

    expect(outcome.approved).toBe(false)
  })

  /** La idempotencia es lo que permite reintentar sin cobrar dos veces. */
  it('tras aprobar, el mismo identificador devuelve el mismo resultado', async () => {
    const gateway = new SimulatedPaymentGateway()

    const first = await gateway.charge(request)
    const second = await gateway.charge({ ...request, card: DECLINED_CARD })

    expect(second).toEqual(first)
    expect(second.approved).toBe(true)
  })

  /**
   * Un rechazo NO se recuerda: si se recordara, corregir el numero de tarjeta
   * no serviria de nada y el pedido quedaria impagable para siempre.
   */
  it('un rechazo no bloquea un reintento posterior con otra tarjeta', async () => {
    const gateway = new SimulatedPaymentGateway()

    const declined = await gateway.charge({ ...request, card: DECLINED_CARD })
    const retried = await gateway.charge(request)

    expect(declined.approved).toBe(false)
    expect(retried.approved).toBe(true)
    expect(retried.reference).toBe('sim-ord-1')
  })

  it('es determinista: no depende del azar', async () => {
    const first = await new SimulatedPaymentGateway().charge(request)
    const second = await new SimulatedPaymentGateway().charge(request)

    expect(second).toEqual(first)
  })
})

describe('InMemoryPlayerInventory', () => {
  const grant = {
    transferId: 'ord-1',
    ownerId: 'acc-1',
    items: [{ sku: 'espada-de-hierro', quantity: 2 }],
  }

  it('entrega las unidades al propietario', async () => {
    const inventory = new InMemoryPlayerInventory()
    await inventory.grant(grant)

    expect(inventory.unitsOf('acc-1', 'espada-de-hierro')).toBe(2)
  })

  /** CA-02: sin duplicacion, ni siquiera reintentando. */
  it('la misma transferencia no entrega dos veces', async () => {
    const inventory = new InMemoryPlayerInventory()

    await inventory.grant(grant)
    await inventory.grant(grant)

    expect(inventory.unitsOf('acc-1', 'espada-de-hierro')).toBe(2)
    expect(inventory.transferCount).toBe(1)
  })

  it('dos transferencias distintas si acumulan', async () => {
    const inventory = new InMemoryPlayerInventory()

    await inventory.grant(grant)
    await inventory.grant({ ...grant, transferId: 'ord-2' })

    expect(inventory.unitsOf('acc-1', 'espada-de-hierro')).toBe(4)
  })

  it('no mezcla los inventarios de dos jugadores', async () => {
    const inventory = new InMemoryPlayerInventory()

    await inventory.grant(grant)
    await inventory.grant({ ...grant, transferId: 'ord-2', ownerId: 'acc-2' })

    expect(inventory.unitsOf('acc-1', 'espada-de-hierro')).toBe(2)
    expect(inventory.unitsOf('acc-2', 'espada-de-hierro')).toBe(2)
    expect(inventory.itemsOf('acc-2')).toEqual([{ sku: 'espada-de-hierro', quantity: 2 }])
  })
})

describe('GetCheckoutSummary', () => {
  it('devuelve los productos vigentes y el total', async () => {
    const harness = buildHarness()
    const cartId = await cartReadyToPay(harness)

    const summary = await harness.summary.execute(cartId)

    expect(summary.lines).toHaveLength(2)
    expect(summary.total).toBe(32_000)
    expect(summary.itemCount).toBe(3)
  })

  it('falla con un pedido inexistente', async () => {
    await expect(buildHarness().summary.execute('inexistente')).rejects.toBeInstanceOf(
      OrderNotFoundError,
    )
  })
})

describe('CheckoutOrder — camino principal', () => {
  /** CP-59-01. */
  it('registra la transaccion, transfiere una sola vez y deja el carrito vacio', async () => {
    const harness = buildHarness()
    const cartId = await cartReadyToPay(harness)

    const result = await harness.checkout.execute({ orderId: cartId, card: VALID_CARD })

    expect(result.paymentReference).toBe(`sim-${cartId}`)
    expect(result.order.status).toBe(OrderStatus.Confirmed)
    expect(result.order.total).toBe(32_000)

    const inventory = harness.inventory as InMemoryPlayerInventory
    expect(inventory.unitsOf('acc-1', 'espada-de-hierro')).toBe(2)
    expect(inventory.unitsOf('acc-1', 'pocion-de-vida')).toBe(1)
    expect(inventory.transferCount).toBe(1)

    // El pedido dejo de ser el borrador, asi que ya no es el carrito.
    expect(await harness.getCart.execute('acc-1')).toBeNull()
  })

  it('no devuelve nunca el numero completo de la tarjeta', async () => {
    const harness = buildHarness()
    const cartId = await cartReadyToPay(harness)

    const result = await harness.checkout.execute({ orderId: cartId, card: VALID_CARD })

    expect(result.maskedCard).toBe('1111')
    expect(JSON.stringify(result)).not.toContain(VALID_CARD.number)
  })

  it('el siguiente carrito del cliente esta vacio', async () => {
    const harness = buildHarness()
    const cartId = await cartReadyToPay(harness)
    await harness.checkout.execute({ orderId: cartId, card: VALID_CARD })

    const next = await harness.openCart.execute('acc-1', 'COP')

    expect(next.id).not.toBe(cartId)
    expect(next.itemCount).toBe(0)
  })
})

describe('CheckoutOrder — cuando no se completa', () => {
  /** CP-59-02: nada de lo que produce una compra exitosa se aplica. */
  it('un pago rechazado no transfiere ni vacia el carrito', async () => {
    const harness = buildHarness()
    const cartId = await cartReadyToPay(harness)

    await expect(
      harness.checkout.execute({ orderId: cartId, card: DECLINED_CARD }),
    ).rejects.toBeInstanceOf(PaymentDeclinedError)

    const inventory = harness.inventory as InMemoryPlayerInventory
    expect(inventory.transferCount).toBe(0)
    expect(inventory.unitsOf('acc-1', 'espada-de-hierro')).toBe(0)

    const cart = await harness.getCart.execute('acc-1')
    expect(cart?.id).toBe(cartId)
    expect(cart?.total).toBe(32_000)
  })

  /** Tras un rechazo, corregir la tarjeta debe permitir completar la compra. */
  it('permite reintentar con otra tarjeta tras un rechazo', async () => {
    const harness = buildHarness()
    const cartId = await cartReadyToPay(harness)

    await expect(
      harness.checkout.execute({ orderId: cartId, card: DECLINED_CARD }),
    ).rejects.toBeInstanceOf(PaymentDeclinedError)

    const result = await harness.checkout.execute({ orderId: cartId, card: VALID_CARD })

    expect(result.order.status).toBe(OrderStatus.Confirmed)
    expect((harness.inventory as InMemoryPlayerInventory).transferCount).toBe(1)
  })

  it('rechaza pagar un carrito vacio', async () => {
    const harness = buildHarness()
    const cart = await harness.openCart.execute('acc-1', 'COP')

    await expect(
      harness.checkout.execute({ orderId: cart.id, card: VALID_CARD }),
    ).rejects.toBeInstanceOf(DomainError)
  })

  it('rechaza pagar un pedido inexistente', async () => {
    await expect(
      buildHarness().checkout.execute({ orderId: 'inexistente', card: VALID_CARD }),
    ).rejects.toBeInstanceOf(OrderNotFoundError)
  })

  it('rechaza pagar dos veces el mismo pedido', async () => {
    const harness = buildHarness()
    const cartId = await cartReadyToPay(harness)
    await harness.checkout.execute({ orderId: cartId, card: VALID_CARD })

    await expect(
      harness.checkout.execute({ orderId: cartId, card: VALID_CARD }),
    ).rejects.toBeInstanceOf(DomainError)

    // Y sobre todo: no hay una segunda transferencia.
    expect((harness.inventory as InMemoryPlayerInventory).transferCount).toBe(1)
  })
})

/**
 * CP-59-03 — consistencia ante un fallo controlado.
 *
 * Se provoca el fallo en el punto que de verdad importa: **despues** de
 * transferir al inventario. Es el unico momento en el que puede quedar un
 * estado a medias, y por eso es el que hay que demostrar recuperable.
 */
describe('CheckoutOrder — consistencia ante fallo simulado', () => {
  /** Inventario que falla la primera vez y funciona a partir de la segunda. */
  class FlakyInventory implements PlayerInventoryPort {
    readonly delegate = new InMemoryPlayerInventory()
    private failuresLeft: number

    constructor(failuresLeft: number) {
      this.failuresLeft = failuresLeft
    }

    async grant(grant: Parameters<PlayerInventoryPort['grant']>[0]): Promise<void> {
      if (this.failuresLeft > 0) {
        this.failuresLeft -= 1

        throw new Error('Player-Inventory no respondio.')
      }

      await this.delegate.grant(grant)
    }
  }

  it('si falla la transferencia, el pedido sigue en borrador y el carrito intacto', async () => {
    const inventory = new FlakyInventory(1)
    const harness = buildHarness(inventory)
    const cartId = await cartReadyToPay(harness)

    await expect(harness.checkout.execute({ orderId: cartId, card: VALID_CARD })).rejects.toThrow()

    expect(inventory.delegate.transferCount).toBe(0)
    const cart = await harness.getCart.execute('acc-1')
    expect(cart?.id).toBe(cartId)
    expect(cart?.total).toBe(32_000)
  })

  it('reintentar tras el fallo completa la compra sin duplicar nada', async () => {
    const inventory = new FlakyInventory(1)
    const harness = buildHarness(inventory)
    const cartId = await cartReadyToPay(harness)

    await expect(harness.checkout.execute({ orderId: cartId, card: VALID_CARD })).rejects.toThrow()

    const result = await harness.checkout.execute({ orderId: cartId, card: VALID_CARD })

    expect(result.order.status).toBe(OrderStatus.Confirmed)
    // Ni perdida, ni duplicacion: exactamente lo comprado.
    expect(inventory.delegate.unitsOf('acc-1', 'espada-de-hierro')).toBe(2)
    expect(inventory.delegate.unitsOf('acc-1', 'pocion-de-vida')).toBe(1)
    expect(inventory.delegate.transferCount).toBe(1)
    expect(await harness.getCart.execute('acc-1')).toBeNull()
  })

  /**
   * Fallo al guardar el pedido ya confirmado: los productos estan entregados
   * pero el pedido sigue en borrador. Reintentar debe terminar la compra sin
   * transferir de nuevo.
   */
  it('si falla el guardado tras transferir, el reintento no duplica la entrega', async () => {
    const inventory = new InMemoryPlayerInventory()
    const harness = buildHarness(inventory)
    const cartId = await cartReadyToPay(harness)

    const save = jest
      .spyOn(harness.orders, 'save')
      .mockRejectedValueOnce(new Error('La base de datos no respondio.'))

    await expect(harness.checkout.execute({ orderId: cartId, card: VALID_CARD })).rejects.toThrow()
    expect(inventory.transferCount).toBe(1)

    save.mockRestore()

    const result = await harness.checkout.execute({ orderId: cartId, card: VALID_CARD })

    expect(result.order.status).toBe(OrderStatus.Confirmed)
    expect(inventory.unitsOf('acc-1', 'espada-de-hierro')).toBe(2)
    expect(inventory.transferCount).toBe(1)
  })
})
