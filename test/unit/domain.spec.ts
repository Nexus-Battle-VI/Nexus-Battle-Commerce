import { Order, OrderStatus } from '../../src/domain/entities/Order'
import {
  CustomerId,
  Money,
  OrderId,
  Quantity,
  Sku,
} from '../../src/domain/value-objects/commerce-values'
import { DomainError } from '../../src/domain/errors/DomainError'

const AT = new Date('2026-08-21T10:00:00.000Z')

const cop = (amount: number): Money => Money.create(amount, 'COP')
const sku = (value: string): Sku => Sku.create(value)
const qty = (value: number): Quantity => Quantity.create(value)

const draft = (): Order =>
  Order.draft({
    id: OrderId.create('ord-1'),
    customerId: CustomerId.create('acc-1'),
    currency: 'COP',
  })

describe('Objetos de valor', () => {
  it('CustomerId, OrderId y Sku normalizan y comparan por valor', () => {
    expect(CustomerId.create('  acc-1 ').value).toBe('acc-1')
    expect(OrderId.create('  ord-1 ').value).toBe('ord-1')
    expect(Sku.create('  Espada-De-Hierro ').value).toBe('espada-de-hierro')

    expect(CustomerId.create('a').equals(CustomerId.create('a'))).toBe(true)
    expect(CustomerId.create('a').equals(CustomerId.create('b'))).toBe(false)
    expect(OrderId.create('a').equals(OrderId.create('a'))).toBe(true)
    expect(OrderId.create('a').equals(OrderId.create('b'))).toBe(false)
    expect(sku('a-b').equals(sku('A-B'))).toBe(true)
    expect(sku('a-b').equals(sku('c-d'))).toBe(false)

    expect(String(CustomerId.create('a'))).toBe('a')
    expect(String(OrderId.create('a'))).toBe('a')
    expect(String(sku('a-b'))).toBe('a-b')
  })

  it('rechazan identificadores invalidos', () => {
    expect(() => CustomerId.create('  ')).toThrow(DomainError)
    expect(() => OrderId.create('  ')).toThrow(DomainError)
    expect(() => Sku.create('Espada_Hierro')).toThrow(DomainError)
  })

  it('Quantity suma, compara y acota', () => {
    expect(qty(2).plus(qty(3)).value).toBe(5)
    expect(qty(2).equals(qty(2))).toBe(true)
    expect(qty(2).equals(qty(3))).toBe(false)

    expect(() => Quantity.create(0)).toThrow(DomainError)
    expect(() => Quantity.create(-1)).toThrow(DomainError)
    expect(() => Quantity.create(1.5)).toThrow(DomainError)
    expect(() => Quantity.create(1_000)).toThrow(DomainError)
    expect(() => qty(999).plus(qty(1))).toThrow(DomainError)
  })

  it('Money opera con enteros y rechaza mezclar monedas', () => {
    expect(Money.create(15_000, ' cop ').currency).toBe('COP')
    expect(cop(1_000).plus(cop(500)).amount).toBe(1_500)
    expect(cop(1_500).times(3).amount).toBe(4_500)
    expect(Money.zero('COP').isZero()).toBe(true)
    expect(cop(100).equals(cop(100))).toBe(true)
    expect(cop(100).equals(Money.create(100, 'USD'))).toBe(false)
    expect(String(cop(100))).toBe('100 COP')

    expect(() => cop(100).plus(Money.create(100, 'USD'))).toThrow(/monedas distintas/)
    expect(() => Money.create(1_500.5, 'COP')).toThrow(DomainError)
    expect(() => Money.create(-1, 'COP')).toThrow(DomainError)
    expect(() => Money.create(100, 'GBP')).toThrow(DomainError)
    expect(() => cop(100).times(-1)).toThrow(DomainError)
    expect(() => cop(100).times(1.5)).toThrow(DomainError)
  })
})

describe('Order', () => {
  it('nace vacio, editable y con total cero', () => {
    const order = draft()

    expect(order.currentStatus).toBe(OrderStatus.Draft)
    expect(order.isEditable).toBe(true)
    expect(order.isConfirmed).toBe(false)
    expect(order.isEmpty).toBe(true)
    expect(order.lineCount).toBe(0)
    expect(order.total.amount).toBe(0)
    expect(order.total.currency).toBe('COP')
  })

  it('calcula el total como suma de subtotales', () => {
    const order = draft()

    order.addLine(sku('espada'), cop(15_000), qty(2))
    order.addLine(sku('pocion'), cop(2_000), qty(3))

    expect(order.subtotalOf(sku('espada'))?.amount).toBe(30_000)
    expect(order.subtotalOf(sku('pocion'))?.amount).toBe(6_000)
    expect(order.total.amount).toBe(36_000)
    expect(order.subtotalOf(sku('inexistente'))).toBeNull()
  })

  it('acumula cantidad y conserva el precio de la primera vez', () => {
    const order = draft()

    order.addLine(sku('espada'), cop(15_000), qty(1))
    // El catalogo subio el precio, pero la linea ya existia.
    order.addLine(sku('espada'), cop(20_000), qty(2))

    expect(order.lineCount).toBe(1)
    expect(order.quantityOf(sku('espada'))).toBe(3)
    // 3 unidades al precio original, no al nuevo.
    expect(order.total.amount).toBe(45_000)
  })

  it('rechaza una linea en otra moneda o con precio cero', () => {
    const order = draft()

    expect(() => {
      order.addLine(sku('espada'), Money.create(100, 'USD'), qty(1))
    }).toThrow(/y la linea llega en USD/)
    expect(() => {
      order.addLine(sku('espada'), Money.zero('COP'), qty(1))
    }).toThrow(/precio unitario cero/)
  })

  it('retira una referencia completa', () => {
    const order = draft()
    order.addLine(sku('espada'), cop(15_000), qty(2))
    order.addLine(sku('pocion'), cop(2_000), qty(1))

    order.removeLine(sku('espada'))

    expect(order.lineCount).toBe(1)
    expect(order.quantityOf(sku('espada'))).toBe(0)
    expect(order.total.amount).toBe(2_000)
  })

  it('rechaza retirar una referencia ausente', () => {
    expect(() => {
      draft().removeLine(sku('inexistente'))
    }).toThrow(/no contiene la referencia/)
  })

  it('confirma el pedido y emite el evento con el total', () => {
    const order = draft()
    order.addLine(sku('espada'), cop(15_000), qty(2))

    order.confirm(AT)

    expect(order.currentStatus).toBe(OrderStatus.Confirmed)
    expect(order.isConfirmed).toBe(true)
    expect(order.isEditable).toBe(false)
    expect(order.pullEvents()[0]).toMatchObject({
      name: 'commerce.order.confirmed',
      customerId: 'acc-1',
      totalAmount: 30_000,
      currency: 'COP',
      lineCount: 1,
    })
  })

  it('rechaza confirmar un pedido vacio', () => {
    expect(() => {
      draft().confirm(AT)
    }).toThrow(/no tiene lineas/)
  })

  it('un pedido confirmado no admite ninguna modificacion', () => {
    const order = draft()
    order.addLine(sku('espada'), cop(15_000), qty(1))
    order.confirm(AT)

    expect(() => {
      order.addLine(sku('pocion'), cop(2_000), qty(1))
    }).toThrow(/confirmado y no admite modificaciones/)
    expect(() => {
      order.removeLine(sku('espada'))
    }).toThrow(/confirmado y no admite modificaciones/)
    expect(() => {
      order.confirm(AT)
    }).toThrow(/confirmado y no admite modificaciones/)
  })

  it('cancela el pedido y emite el evento con el motivo', () => {
    const order = draft()
    order.addLine(sku('espada'), cop(15_000), qty(1))

    order.cancel('Sin existencias', AT)

    expect(order.currentStatus).toBe(OrderStatus.Cancelled)
    expect(order.pullEvents()[0]).toMatchObject({
      name: 'commerce.order.cancelled',
      reason: 'Sin existencias',
    })
  })

  it('permite cancelar un pedido ya confirmado', () => {
    const order = draft()
    order.addLine(sku('espada'), cop(15_000), qty(1))
    order.confirm(AT)
    order.pullEvents()

    order.cancel('Devolucion aceptada', AT)

    expect(order.currentStatus).toBe(OrderStatus.Cancelled)
  })

  it('rechaza cancelar dos veces y modificar un cancelado', () => {
    const order = draft()
    order.addLine(sku('espada'), cop(15_000), qty(1))
    order.cancel('Motivo', AT)

    expect(() => {
      order.cancel('Otro motivo', AT)
    }).toThrow(/ya esta cancelado/)
    expect(() => {
      order.addLine(sku('pocion'), cop(2_000), qty(1))
    }).toThrow(/cancelado y no admite modificaciones/)
  })

  it('produce una instantanea ordenada con subtotales', () => {
    const order = draft()
    order.addLine(sku('pocion'), cop(2_000), qty(3))
    order.addLine(sku('arco'), cop(12_000), qty(1))

    expect(order.toSnapshot()).toEqual({
      id: 'ord-1',
      customerId: 'acc-1',
      status: OrderStatus.Draft,
      currency: 'COP',
      totalAmount: 18_000,
      lines: [
        { sku: 'arco', unitPriceAmount: 12_000, quantity: 1, subtotalAmount: 12_000 },
        { sku: 'pocion', unitPriceAmount: 2_000, quantity: 3, subtotalAmount: 6_000 },
      ],
    })
  })

  it('reconstituye un pedido persistido sin emitir eventos', () => {
    const order = Order.restore({
      id: OrderId.create('ord-9'),
      customerId: CustomerId.create('acc-2'),
      currency: 'COP',
      status: OrderStatus.Confirmed,
      lines: [{ sku: sku('espada'), unitPrice: cop(15_000), quantity: qty(2) }],
    })

    expect(order.pullEvents()).toHaveLength(0)
    expect(order.isConfirmed).toBe(true)
    expect(order.total.amount).toBe(30_000)
  })

  it('rechaza reconstituir con moneda inconsistente o referencia repetida', () => {
    const base = {
      id: OrderId.create('ord-9'),
      customerId: CustomerId.create('acc-2'),
      currency: 'COP',
      status: OrderStatus.Draft,
    }

    expect(() =>
      Order.restore({
        ...base,
        lines: [{ sku: sku('espada'), unitPrice: Money.create(100, 'USD'), quantity: qty(1) }],
      }),
    ).toThrow(/esta en USD y el pedido en COP/)

    expect(() =>
      Order.restore({
        ...base,
        lines: [
          { sku: sku('espada'), unitPrice: cop(100), quantity: qty(1) },
          { sku: sku('espada'), unitPrice: cop(100), quantity: qty(2) },
        ],
      }),
    ).toThrow(/repite la referencia/)
  })
})
