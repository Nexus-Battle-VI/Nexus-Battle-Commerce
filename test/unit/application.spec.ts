import {
  AddOrderLine,
  CancelOrder,
  ConfirmOrder,
  CreateOrder,
  GetOrder,
  ListCustomerOrders,
  RemoveOrderLine,
} from '../../src/application/use-cases/OrderUseCases'
import {
  OrderNotFoundError,
  ProductNotPurchasableError,
} from '../../src/application/errors/ApplicationError'
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
import { ConfigurationError, loadConfig } from '../../src/infrastructure/config/env'
import { createLogger } from '../../src/infrastructure/observability/logger'
import { buildLiveness, buildReadiness, buildVersion } from '../../src/infrastructure/health/health'
import { SystemClock } from '../../src/adapters/outbound/system/SystemClock'
import { UuidGenerator } from '../../src/adapters/outbound/system/UuidGenerator'

const FIXED_NOW = new Date('2026-08-21T10:00:00.000Z')

interface Harness {
  orders: InMemoryOrderRepository
  pricing: LocalCatalogPricing
  create: CreateOrder
  add: AddOrderLine
  remove: RemoveOrderLine
  confirm: ConfirmOrder
  cancel: CancelOrder
  get: GetOrder
  list: ListCustomerOrders
}

const sequence = (prefix: string): (() => string) => {
  let counter = 0

  return (): string => {
    counter += 1

    return `${prefix}-${String(counter)}`
  }
}

const buildHarness = (): Harness => {
  const orders = new InMemoryOrderRepository()
  const pricing = new LocalCatalogPricing(DEMO_PRICES)
  const deps = {
    orders,
    pricing,
    clock: { now: (): Date => FIXED_NOW },
    ids: { generate: sequence('ord') },
  }

  return {
    orders,
    pricing,
    create: new CreateOrder(deps),
    add: new AddOrderLine(deps),
    remove: new RemoveOrderLine(deps),
    confirm: new ConfirmOrder(deps),
    cancel: new CancelOrder(deps),
    get: new GetOrder(orders),
    list: new ListCustomerOrders(orders),
  }
}

const createCommand = { customerId: 'acc-1', currency: 'COP' }

describe('CreateOrder', () => {
  it('abre un pedido vacio en borrador', async () => {
    const harness = buildHarness()

    const result = await harness.create.execute(createCommand)

    expect(result).toEqual({
      id: 'ord-1',
      customerId: 'acc-1',
      status: OrderStatus.Draft,
      currency: 'COP',
      total: 0,
      itemCount: 0,
      lines: [],
    })
    expect(harness.orders.size).toBe(1)
  })

  it('normaliza la moneda', async () => {
    const harness = buildHarness()

    expect((await harness.create.execute({ ...createCommand, currency: ' cop ' })).currency).toBe(
      'COP',
    )
  })

  it.each([
    ['cliente vacio', { customerId: '  ' }],
    ['moneda no soportada', { currency: 'GBP' }],
  ])('rechaza una peticion con %s', async (_caso, override) => {
    const harness = buildHarness()

    await expect(harness.create.execute({ ...createCommand, ...override })).rejects.toBeInstanceOf(
      DomainError,
    )
    expect(harness.orders.size).toBe(0)
  })
})

describe('AddOrderLine', () => {
  it('consulta el precio al catalogo y lo congela en la linea', async () => {
    const harness = buildHarness()
    const order = await harness.create.execute(createCommand)

    const result = await harness.add.execute({
      orderId: order.id,
      sku: 'espada-de-hierro',
      quantity: 2,
    })

    expect(result.lines).toEqual([
      { sku: 'espada-de-hierro', unitPrice: 15_000, quantity: 2, subtotal: 30_000 },
    ])
    expect(result.total).toBe(30_000)
    // Se relee del repositorio para confirmar que quedo persistido.
    expect((await harness.get.execute(order.id)).total).toBe(30_000)
  })

  it('suma varias referencias en el total', async () => {
    const harness = buildHarness()
    const order = await harness.create.execute(createCommand)

    await harness.add.execute({ orderId: order.id, sku: 'espada-de-hierro', quantity: 1 })
    const result = await harness.add.execute({
      orderId: order.id,
      sku: 'pocion-de-vida',
      quantity: 3,
    })

    expect(result.lines).toHaveLength(2)
    expect(result.total).toBe(15_000 + 6_000)
  })

  it('rechaza un producto que no esta en el catalogo', async () => {
    const harness = buildHarness()
    const order = await harness.create.execute(createCommand)

    await expect(
      harness.add.execute({ orderId: order.id, sku: 'producto-inexistente', quantity: 1 }),
    ).rejects.toBeInstanceOf(ProductNotPurchasableError)
  })

  it('falla cuando el pedido no existe', async () => {
    const harness = buildHarness()

    await expect(
      harness.add.execute({ orderId: 'inexistente', sku: 'espada-de-hierro', quantity: 1 }),
    ).rejects.toBeInstanceOf(OrderNotFoundError)
  })

  it('propaga el rechazo de un pedido confirmado', async () => {
    const harness = buildHarness()
    const order = await harness.create.execute(createCommand)
    await harness.add.execute({ orderId: order.id, sku: 'espada-de-hierro', quantity: 1 })
    await harness.confirm.execute(order.id)

    await expect(
      harness.add.execute({ orderId: order.id, sku: 'pocion-de-vida', quantity: 1 }),
    ).rejects.toBeInstanceOf(DomainError)
  })

  it('rechaza una cantidad invalida o una referencia mal formada', async () => {
    const harness = buildHarness()
    const order = await harness.create.execute(createCommand)

    await expect(
      harness.add.execute({ orderId: order.id, sku: 'espada-de-hierro', quantity: 0 }),
    ).rejects.toBeInstanceOf(DomainError)
    await expect(
      harness.add.execute({ orderId: order.id, sku: 'Espada_Hierro', quantity: 1 }),
    ).rejects.toBeInstanceOf(DomainError)
  })
})

describe('RemoveOrderLine', () => {
  it('retira la referencia y recalcula el total', async () => {
    const harness = buildHarness()
    const order = await harness.create.execute(createCommand)
    await harness.add.execute({ orderId: order.id, sku: 'espada-de-hierro', quantity: 1 })
    await harness.add.execute({ orderId: order.id, sku: 'pocion-de-vida', quantity: 2 })

    const result = await harness.remove.execute(order.id, 'espada-de-hierro')

    expect(result.lines).toHaveLength(1)
    expect(result.total).toBe(4_000)
  })

  it('falla cuando el pedido no existe y propaga la referencia ausente', async () => {
    const harness = buildHarness()
    const order = await harness.create.execute(createCommand)

    await expect(harness.remove.execute('inexistente', 'espada-de-hierro')).rejects.toBeInstanceOf(
      OrderNotFoundError,
    )
    await expect(harness.remove.execute(order.id, 'espada-de-hierro')).rejects.toBeInstanceOf(
      DomainError,
    )
  })
})

describe('ConfirmOrder', () => {
  it('confirma y persiste el pedido', async () => {
    const harness = buildHarness()
    const order = await harness.create.execute(createCommand)
    await harness.add.execute({ orderId: order.id, sku: 'espada-de-hierro', quantity: 2 })

    const result = await harness.confirm.execute(order.id)

    expect(result.status).toBe(OrderStatus.Confirmed)
    expect((await harness.get.execute(order.id)).status).toBe(OrderStatus.Confirmed)
  })

  it('rechaza confirmar un pedido vacio y uno inexistente', async () => {
    const harness = buildHarness()
    const order = await harness.create.execute(createCommand)

    await expect(harness.confirm.execute(order.id)).rejects.toBeInstanceOf(DomainError)
    await expect(harness.confirm.execute('inexistente')).rejects.toBeInstanceOf(OrderNotFoundError)
  })
})

describe('CancelOrder', () => {
  it('cancela y persiste el pedido', async () => {
    const harness = buildHarness()
    const order = await harness.create.execute(createCommand)
    await harness.add.execute({ orderId: order.id, sku: 'espada-de-hierro', quantity: 1 })

    const result = await harness.cancel.execute(order.id, 'Sin existencias')

    expect(result.status).toBe(OrderStatus.Cancelled)
    expect((await harness.get.execute(order.id)).status).toBe(OrderStatus.Cancelled)
  })

  it('falla con un pedido inexistente y rechaza la doble cancelacion', async () => {
    const harness = buildHarness()
    const order = await harness.create.execute(createCommand)
    await harness.cancel.execute(order.id, 'Motivo')

    await expect(harness.cancel.execute('inexistente', 'Motivo')).rejects.toBeInstanceOf(
      OrderNotFoundError,
    )
    await expect(harness.cancel.execute(order.id, 'Otro motivo')).rejects.toBeInstanceOf(
      DomainError,
    )
  })
})

describe('GetOrder y ListCustomerOrders', () => {
  it('recupera un pedido y falla con uno inexistente', async () => {
    const harness = buildHarness()
    const order = await harness.create.execute(createCommand)

    expect((await harness.get.execute(order.id)).id).toBe(order.id)
    await expect(harness.get.execute('inexistente')).rejects.toBeInstanceOf(OrderNotFoundError)
    await expect(harness.get.execute('  ')).rejects.toBeInstanceOf(DomainError)
  })

  it('lista solo los pedidos del cliente indicado', async () => {
    const harness = buildHarness()
    await harness.create.execute(createCommand)
    await harness.create.execute(createCommand)
    await harness.create.execute({ customerId: 'acc-2', currency: 'COP' })

    expect(await harness.list.execute('acc-1')).toHaveLength(2)
    expect(await harness.list.execute('acc-2')).toHaveLength(1)
    expect(await harness.list.execute('acc-sin-pedidos')).toHaveLength(0)
  })

  it('rechaza un cliente vacio', async () => {
    await expect(buildHarness().list.execute('  ')).rejects.toBeInstanceOf(DomainError)
  })
})

describe('LocalCatalogPricing', () => {
  it('devuelve el precio de una referencia conocida y null en caso contrario', async () => {
    const pricing = new LocalCatalogPricing(DEMO_PRICES)

    expect(await pricing.priceOf(' Espada-De-Hierro ')).toEqual({
      sku: 'espada-de-hierro',
      amount: 15_000,
      currency: 'COP',
    })
    expect(await pricing.priceOf('inexistente')).toBeNull()
    expect(pricing.size).toBe(DEMO_PRICES.length)
  })
})

describe('InMemoryOrderRepository', () => {
  const buildOrder = (id = 'ord-1', customer = 'acc-1'): Order => {
    const order = Order.draft({
      id: OrderId.create(id),
      customerId: CustomerId.create(customer),
      currency: 'COP',
    })
    order.addLine(Sku.create('espada'), Money.create(15_000, 'COP'), Quantity.create(1))

    return order
  }

  it('almacena instantaneas, no referencias vivas al agregado', async () => {
    const repository = new InMemoryOrderRepository()
    const order = buildOrder()
    await repository.save(order)

    // Se muta el agregado sin volver a guardarlo.
    order.addLine(Sku.create('pocion'), Money.create(2_000, 'COP'), Quantity.create(1))

    const stored = await repository.findById(OrderId.create('ord-1'))

    expect(stored?.lineCount).toBe(1)
    expect(order.lineCount).toBe(2)
  })

  it('reconstituye el pedido con sus lineas y su total', async () => {
    const repository = new InMemoryOrderRepository()
    await repository.save(buildOrder())

    const stored = await repository.findById(OrderId.create('ord-1'))

    expect(stored?.total.amount).toBe(15_000)
    expect(stored?.total.currency).toBe('COP')
  })

  it('filtra por cliente y devuelve null para un pedido desconocido', async () => {
    const repository = new InMemoryOrderRepository()
    await repository.save(buildOrder('ord-1', 'acc-1'))
    await repository.save(buildOrder('ord-2', 'acc-2'))

    expect(await repository.findById(OrderId.create('nada'))).toBeNull()
    expect(await repository.findByCustomer(CustomerId.create('acc-1'))).toHaveLength(1)
    expect(await repository.findByCustomer(CustomerId.create('acc-9'))).toHaveLength(0)
    expect(repository.size).toBe(2)

    repository.clear()
    expect(repository.size).toBe(0)
  })
})

describe('loadConfig', () => {
  it('aplica valores por defecto seguros para el entorno local', () => {
    expect(loadConfig({})).toMatchObject({
      nodeEnv: 'development',
      serviceName: 'nexus-battle-commerce',
      port: 3005,
      persistenceDriver: 'memory',
      swaggerEnabled: true,
    })
  })

  it('exige la cadena de conexion cuando el driver es postgres', () => {
    expect(() => loadConfig({ PERSISTENCE_DRIVER: 'postgres' })).toThrow(
      /DATABASE_URL es obligatorio/,
    )
  })

  it('acepta una configuracion postgres completa', () => {
    expect(
      loadConfig({
        PERSISTENCE_DRIVER: 'postgres',
        DATABASE_URL: 'postgres://usuario@localhost:5432/commerce',
      }).persistenceDriver,
    ).toBe('postgres')
  })

  it('deshabilita la documentacion interactiva en produccion por defecto', () => {
    // Produccion exige autenticacion Y contrato interno con Catalog:
    // `loadConfig` se niega a arrancar sin ellos. Se aportan aqui porque el
    // objeto de esta prueba es la documentacion interactiva.
    expect(
      loadConfig({
        NODE_ENV: 'production',
        AUTH_MODE: 'jwt',
        COGNITO_USER_POOL_ID: 'us-east-1_abc',
        COGNITO_CLIENT_ID: 'cliente',
        CATALOG_INTERNAL_URL: 'http://catalog:3003',
        INTERNAL_SERVICE_AUTH_SECRET: 'secreto-ficticio-de-pruebas',
      }).swaggerEnabled,
    ).toBe(false)
  })

  it('trata una variable vacia como ausente', () => {
    expect(loadConfig({ LOG_LEVEL: '', PORT: '' })).toMatchObject({ logLevel: 'info', port: 3005 })
  })

  it.each([
    ['un valor fuera del catalogo', { LOG_LEVEL: 'verbose' }],
    ['un entero mal formado', { PORT: 'abc' }],
    ['un puerto fuera de rango', { PORT: '99999' }],
    ['un booleano invalido', { SWAGGER_ENABLED: 'si' }],
  ])('rechaza %s', (_caso, env) => {
    expect(() => loadConfig(env)).toThrow(ConfigurationError)
  })
})

describe('observabilidad, salud y utilidades', () => {
  it('el registro es JSON estructurado y respeta el umbral', () => {
    const lines: string[] = []
    const logger = createLogger({
      level: 'warn',
      service: 'commerce',
      version: '0.1.0',
      sink: (line) => lines.push(line),
      clock: () => FIXED_NOW,
    })

    logger.debug('no')
    logger.info('no')
    logger.warn('si', { orderId: 'ord-1' })
    logger.error('si')

    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ level: 'warn', orderId: 'ord-1' })
  })

  it('admite registros sin contexto en todos los niveles', () => {
    const lines: string[] = []
    const logger = createLogger({
      level: 'debug',
      service: 'commerce',
      version: '0.1.0',
      sink: (line) => lines.push(line),
    })

    logger.debug('a')
    logger.info('b')
    logger.warn('c')
    logger.error('d')

    expect(lines).toHaveLength(4)
  })

  it('las sondas distinguen exito, fallo y excepcion', () => {
    expect(buildLiveness()).toEqual({ status: 'ok', checks: {} })
    expect(buildReadiness([{ name: 'repo', check: (): boolean => true }]).status).toBe('ok')
    expect(buildReadiness([{ name: 'repo', check: (): boolean => false }]).status).toBe('error')
    expect(
      buildReadiness([
        {
          name: 'repo',
          check: (): boolean => {
            throw new Error('sin conexion')
          },
        },
      ]),
    ).toEqual({ status: 'error', checks: { repo: 'error' } })
    expect(buildVersion({ service: 'a', version: 'b', nodeEnv: 'c' })).toEqual({
      service: 'a',
      version: 'b',
      nodeEnv: 'c',
    })
  })

  it('el reloj y el generador de identificadores funcionan', () => {
    expect(new SystemClock().now().getTime()).toBeGreaterThan(0)
    expect(new UuidGenerator().generate()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
  })
})
