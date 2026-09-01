import {
  AddToWishlist,
  GetWishlistItemStatus,
  ListWishlist,
  RemoveFromWishlist,
} from '../../src/application/use-cases/WishlistUseCases'
import { InMemoryOrderRepository } from '../../src/adapters/outbound/persistence/InMemoryOrderRepository'
import { InMemoryWishlistRepository } from '../../src/adapters/outbound/persistence/InMemoryWishlistRepository'
import { Order } from '../../src/domain/entities/Order'
import { Wishlist } from '../../src/domain/entities/Wishlist'
import {
  CustomerId,
  Money,
  OrderId,
  Quantity,
  Sku,
} from '../../src/domain/value-objects/commerce-values'
import { DomainError } from '../../src/domain/errors/DomainError'

describe('Wishlist', () => {
  const customerId = CustomerId.create('acc-1')

  it('empieza vacia', () => {
    const wishlist = Wishlist.empty(customerId)

    expect(wishlist.size).toBe(0)
    expect(wishlist.toSnapshot()).toEqual({ customerId: 'acc-1', skus: [] })
  })

  it('anadir una referencia ya presente es idempotente', () => {
    const wishlist = Wishlist.empty(customerId)
    wishlist.add(Sku.create('espada-de-hierro'))
    wishlist.add(Sku.create('espada-de-hierro'))

    expect(wishlist.size).toBe(1)
    expect(wishlist.contains(Sku.create('espada-de-hierro'))).toBe(true)
  })

  it('retira una referencia presente', () => {
    const wishlist = Wishlist.empty(customerId)
    wishlist.add(Sku.create('espada-de-hierro'))

    wishlist.remove(Sku.create('espada-de-hierro'))

    expect(wishlist.contains(Sku.create('espada-de-hierro'))).toBe(false)
    expect(wishlist.size).toBe(0)
  })

  it('rechaza retirar una referencia ausente', () => {
    const wishlist = Wishlist.empty(customerId)

    expect(() => {
      wishlist.remove(Sku.create('pocion-de-vida'))
    }).toThrow(DomainError)
  })

  it('se reconstituye ordenada por referencia', () => {
    const wishlist = Wishlist.restore({
      customerId,
      skus: [Sku.create('pocion-de-vida'), Sku.create('escudo-de-madera')],
    })

    expect(wishlist.toSnapshot().skus).toEqual(['escudo-de-madera', 'pocion-de-vida'])
  })
})

describe('InMemoryWishlistRepository', () => {
  it('almacena instantaneas, no referencias vivas al agregado', async () => {
    const repository = new InMemoryWishlistRepository()
    const wishlist = Wishlist.empty(CustomerId.create('acc-1'))
    wishlist.add(Sku.create('espada'))
    await repository.save(wishlist)

    wishlist.add(Sku.create('pocion'))

    const stored = await repository.findByCustomer(CustomerId.create('acc-1'))

    expect(stored?.size).toBe(1)
    expect(wishlist.size).toBe(2)
  })

  it('devuelve null para un cliente sin lista', async () => {
    const repository = new InMemoryWishlistRepository()

    expect(await repository.findByCustomer(CustomerId.create('acc-sin-lista'))).toBeNull()
  })

  it('size y clear', async () => {
    const repository = new InMemoryWishlistRepository()
    const wishlist = Wishlist.empty(CustomerId.create('acc-1'))
    wishlist.add(Sku.create('espada'))
    await repository.save(wishlist)

    expect(repository.size).toBe(1)
    repository.clear()
    expect(repository.size).toBe(0)
  })
})

describe('Casos de uso de la lista de deseos', () => {
  const buildHarness = () => {
    const wishlist = new InMemoryWishlistRepository()
    const orders = new InMemoryOrderRepository()
    const deps = { wishlist, orders }

    return {
      wishlist,
      orders,
      add: new AddToWishlist(deps),
      remove: new RemoveFromWishlist(deps),
      status: new GetWishlistItemStatus(deps),
      list: new ListWishlist(deps),
    }
  }

  const confirmedOrderWith = (customer: string, sku: string): Order => {
    const order = Order.draft({
      id: OrderId.create(`ord-${sku}`),
      customerId: CustomerId.create(customer),
      currency: 'COP',
    })
    order.addLine(Sku.create(sku), Money.create(1_000, 'COP'), Quantity.create(1))
    order.confirm(new Date('2026-08-21T10:00:00.000Z'))

    return order
  }

  describe('AddToWishlist', () => {
    it('crea la lista si el cliente no tenia una y la marca como deseada', async () => {
      const harness = buildHarness()

      const result = await harness.add.execute('acc-1', 'espada-de-hierro')

      expect(result).toEqual({ sku: 'espada-de-hierro', enDeseos: true, adquirido: false })
      expect((await harness.wishlist.findByCustomer(CustomerId.create('acc-1')))?.size).toBe(1)
    })

    it('reporta adquirido si ya existe un pedido confirmado con esa referencia', async () => {
      const harness = buildHarness()
      await harness.orders.save(confirmedOrderWith('acc-1', 'espada-de-hierro'))

      const result = await harness.add.execute('acc-1', 'espada-de-hierro')

      expect(result.adquirido).toBe(true)
    })

    it('un pedido en borrador no cuenta como adquirido', async () => {
      const harness = buildHarness()
      const draft = Order.draft({
        id: OrderId.create('ord-1'),
        customerId: CustomerId.create('acc-1'),
        currency: 'COP',
      })
      draft.addLine(Sku.create('espada-de-hierro'), Money.create(1_000, 'COP'), Quantity.create(1))
      await harness.orders.save(draft)

      expect((await harness.add.execute('acc-1', 'espada-de-hierro')).adquirido).toBe(false)
    })

    it('rechaza un cliente vacio o una referencia mal formada', async () => {
      const harness = buildHarness()

      await expect(harness.add.execute('  ', 'espada-de-hierro')).rejects.toBeInstanceOf(
        DomainError,
      )
      await expect(harness.add.execute('acc-1', 'Espada_Hierro')).rejects.toBeInstanceOf(
        DomainError,
      )
    })
  })

  describe('RemoveFromWishlist', () => {
    it('retira una referencia presente', async () => {
      const harness = buildHarness()
      await harness.add.execute('acc-1', 'espada-de-hierro')

      const result = await harness.remove.execute('acc-1', 'espada-de-hierro')

      expect(result).toEqual({ sku: 'espada-de-hierro', enDeseos: false, adquirido: false })
    })

    it('rechaza retirar una referencia que no esta en la lista', async () => {
      const harness = buildHarness()

      await expect(harness.remove.execute('acc-1', 'espada-de-hierro')).rejects.toBeInstanceOf(
        DomainError,
      )
    })
  })

  describe('GetWishlistItemStatus', () => {
    it('devuelve enDeseos falso para un cliente sin lista', async () => {
      const harness = buildHarness()

      expect(await harness.status.execute('acc-1', 'espada-de-hierro')).toEqual({
        sku: 'espada-de-hierro',
        enDeseos: false,
        adquirido: false,
      })
    })

    it('combina lista de deseos y pedidos confirmados', async () => {
      const harness = buildHarness()
      await harness.add.execute('acc-1', 'espada-de-hierro')
      await harness.orders.save(confirmedOrderWith('acc-1', 'espada-de-hierro'))

      expect(await harness.status.execute('acc-1', 'espada-de-hierro')).toEqual({
        sku: 'espada-de-hierro',
        enDeseos: true,
        adquirido: true,
      })
    })
  })

  describe('ListWishlist', () => {
    it('lista vacia para un cliente sin deseos', async () => {
      const harness = buildHarness()

      expect(await harness.list.execute('acc-1')).toEqual([])
    })

    it('cada referencia lleva su propia marca de adquirido', async () => {
      const harness = buildHarness()
      await harness.add.execute('acc-1', 'espada-de-hierro')
      await harness.add.execute('acc-1', 'pocion-de-vida')
      await harness.orders.save(confirmedOrderWith('acc-1', 'espada-de-hierro'))

      const result = await harness.list.execute('acc-1')

      expect(result).toEqual([
        { sku: 'espada-de-hierro', enDeseos: true, adquirido: true },
        { sku: 'pocion-de-vida', enDeseos: true, adquirido: false },
      ])
    })

    it('no mezcla la lista de un cliente con la de otro', async () => {
      const harness = buildHarness()
      await harness.add.execute('acc-1', 'espada-de-hierro')
      await harness.add.execute('acc-2', 'pocion-de-vida')

      expect(await harness.list.execute('acc-1')).toEqual([
        { sku: 'espada-de-hierro', enDeseos: true, adquirido: false },
      ])
    })
  })
})
