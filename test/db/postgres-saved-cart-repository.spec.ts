import 'reflect-metadata'

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { sql, type Kysely } from 'kysely'

import { describeError } from '../../src/infrastructure/observability/describe-error'
import { createDatabase, migrateToLatest } from '../../src/infrastructure/persistence/database'
import { PostgresSavedCartRepository } from '../../src/adapters/outbound/persistence/PostgresSavedCartRepository'
import type { Database } from '../../src/adapters/outbound/persistence/schema'
import { SavedCart } from '../../src/domain/entities/SavedCart'
import { CustomerId } from '../../src/domain/value-objects/commerce-values'

/**
 * Adaptador del carrito guardado contra un PostgreSQL real, en contenedor.
 *
 * Verifica ademas las restricciones de la migracion: son parte del contrato de
 * persistencia y solo un motor de verdad puede demostrarlas.
 */
describe('PostgresSavedCartRepository', () => {
  let container: StartedPostgreSqlContainer
  let db: Kysely<Database>
  let repository: PostgresSavedCartRepository

  const cartOf = (
    customer: string,
    lines: readonly { sku: string; unitPriceAmount: number; quantity: number }[],
    currency = 'COP',
  ): SavedCart => SavedCart.fromOrder({ customerId: customer, currency, lines })

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine').start()
    db = createDatabase({ connectionString: container.getConnectionUri() })

    const { error } = await migrateToLatest(db)

    if (error !== undefined) {
      throw new Error(`Las migraciones fallaron: ${describeError(error)}`)
    }
  }, 120_000)

  afterAll(async () => {
    await db.destroy()
    await container.stop()
  })

  beforeEach(async () => {
    repository = new PostgresSavedCartRepository(db)
    await db.deleteFrom('saved_cart_items').execute()
  })

  it('guarda y recupera un carrito con varias lineas', async () => {
    await repository.save(
      cartOf('sub-ana', [
        { sku: 'espada-de-hierro', unitPriceAmount: 15_000, quantity: 2 },
        { sku: 'pocion-de-vida', unitPriceAmount: 2_000, quantity: 3 },
      ]),
    )

    const recovered = await repository.findByCustomer(CustomerId.create('sub-ana'))

    expect(recovered?.size).toBe(2)
    expect(recovered?.currency).toBe('COP')
    expect(recovered?.toSnapshot().items).toEqual(
      expect.arrayContaining([
        { sku: 'espada-de-hierro', unitPriceAmount: 15_000, quantity: 2 },
        { sku: 'pocion-de-vida', unitPriceAmount: 2_000, quantity: 3 },
      ]),
    )
  })

  it('devuelve null cuando el cliente no guardo nada', async () => {
    expect(await repository.findByCustomer(CustomerId.create('sub-nadie'))).toBeNull()
  })

  it('guardar de nuevo reemplaza el contenido anterior', async () => {
    await repository.save(
      cartOf('sub-ana', [{ sku: 'espada-de-hierro', unitPriceAmount: 15_000, quantity: 1 }]),
    )
    await repository.save(
      cartOf('sub-ana', [{ sku: 'arco-corto', unitPriceAmount: 12_000, quantity: 5 }]),
    )

    const recovered = await repository.findByCustomer(CustomerId.create('sub-ana'))

    expect(recovered?.toSnapshot().items).toEqual([
      { sku: 'arco-corto', unitPriceAmount: 12_000, quantity: 5 },
    ])
  })

  it('aisla los carritos de clientes distintos', async () => {
    await repository.save(
      cartOf('sub-ana', [{ sku: 'espada-de-hierro', unitPriceAmount: 15_000, quantity: 1 }]),
    )
    await repository.save(
      cartOf('sub-luis', [{ sku: 'arco-corto', unitPriceAmount: 12_000, quantity: 2 }]),
    )

    const ana = await repository.findByCustomer(CustomerId.create('sub-ana'))
    const luis = await repository.findByCustomer(CustomerId.create('sub-luis'))

    expect(ana?.toSnapshot().items[0]?.sku).toBe('espada-de-hierro')
    expect(luis?.toSnapshot().items[0]?.sku).toBe('arco-corto')
  })

  it('descarta el carrito guardado de un cliente sin tocar el de otro', async () => {
    await repository.save(
      cartOf('sub-ana', [{ sku: 'espada-de-hierro', unitPriceAmount: 15_000, quantity: 1 }]),
    )
    await repository.save(
      cartOf('sub-luis', [{ sku: 'arco-corto', unitPriceAmount: 12_000, quantity: 1 }]),
    )

    await repository.deleteByCustomer(CustomerId.create('sub-ana'))

    expect(await repository.findByCustomer(CustomerId.create('sub-ana'))).toBeNull()
    expect(await repository.findByCustomer(CustomerId.create('sub-luis'))).not.toBeNull()
  })

  /** Un importe que desbordaria el entero de 32 bits sigue siendo exacto. */
  it('conserva importes grandes sin redondear', async () => {
    await repository.save(
      cartOf('sub-ana', [
        { sku: 'espada-de-hierro', unitPriceAmount: 9_007_199_254_740_991, quantity: 1 },
      ]),
    )

    const recovered = await repository.findByCustomer(CustomerId.create('sub-ana'))

    expect(recovered?.toSnapshot().items[0]?.unitPriceAmount).toBe(9_007_199_254_740_991)
  })

  it('la clave primaria impide dos filas para la misma referencia', async () => {
    await db
      .insertInto('saved_cart_items')
      .values({
        customer_id: 'sub-ana',
        sku: 'espada-de-hierro',
        currency: 'COP',
        unit_price_amount: '15000',
        quantity: 1,
      })
      .execute()

    await expect(
      db
        .insertInto('saved_cart_items')
        .values({
          customer_id: 'sub-ana',
          sku: 'espada-de-hierro',
          currency: 'COP',
          unit_price_amount: '15000',
          quantity: 2,
        })
        .execute(),
    ).rejects.toThrow()
  })

  it('la base rechaza una referencia sin normalizar', async () => {
    await expect(
      db
        .insertInto('saved_cart_items')
        .values({
          customer_id: 'sub-ana',
          sku: 'Espada De Hierro',
          currency: 'COP',
          unit_price_amount: '15000',
          quantity: 1,
        })
        .execute(),
    ).rejects.toThrow()
  })

  it('la base rechaza cantidad cero e importe negativo', async () => {
    await expect(
      db
        .insertInto('saved_cart_items')
        .values({
          customer_id: 'sub-ana',
          sku: 'espada-de-hierro',
          currency: 'COP',
          unit_price_amount: '15000',
          quantity: 0,
        })
        .execute(),
    ).rejects.toThrow()

    await expect(
      db
        .insertInto('saved_cart_items')
        .values({
          customer_id: 'sub-ana',
          sku: 'arco-corto',
          currency: 'COP',
          unit_price_amount: '-1',
          quantity: 1,
        })
        .execute(),
    ).rejects.toThrow()
  })

  it('la base rechaza una moneda no soportada', async () => {
    await expect(
      db
        .insertInto('saved_cart_items')
        .values({
          customer_id: 'sub-ana',
          sku: 'espada-de-hierro',
          currency: 'GBP',
          unit_price_amount: '15000',
          quantity: 1,
        })
        .execute(),
    ).rejects.toThrow()
  })

  it('la migracion creo el indice por cliente', async () => {
    const result = await sql<{
      indexname: string
    }>`SELECT indexname FROM pg_indexes WHERE tablename = 'saved_cart_items'`.execute(db)

    expect(result.rows.map((row) => row.indexname)).toContain('saved_cart_items_por_cliente')
  })
})
