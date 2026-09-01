import 'reflect-metadata'

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import type { Kysely } from 'kysely'

import { describeError } from '../../src/infrastructure/observability/describe-error'
import { createDatabase, migrateToLatest } from '../../src/infrastructure/persistence/database'
import { PostgresWishlistRepository } from '../../src/adapters/outbound/persistence/PostgresWishlistRepository'
import type { Database } from '../../src/adapters/outbound/persistence/schema'
import { Wishlist } from '../../src/domain/entities/Wishlist'
import { CustomerId, Sku } from '../../src/domain/value-objects/commerce-values'

/**
 * Adaptador de PostgreSQL contra un motor REAL, en contenedor. Igual que
 * `postgres-order-repository.spec.ts`.
 */
describe('PostgresWishlistRepository', () => {
  let container: StartedPostgreSqlContainer
  let db: Kysely<Database>
  let repository: PostgresWishlistRepository

  const buildWishlist = (customer: string, skus: readonly string[]): Wishlist => {
    const wishlist = Wishlist.empty(CustomerId.create(customer))

    for (const sku of skus) {
      wishlist.add(Sku.create(sku))
    }

    return wishlist
  }

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

  beforeEach(() => {
    repository = new PostgresWishlistRepository(db)
  })

  it('guarda y recupera una lista con varias referencias', async () => {
    const wishlist = buildWishlist('sub-ana', ['espada-de-hierro', 'pocion-de-vida'])
    await repository.save(wishlist)

    const found = await repository.findByCustomer(CustomerId.create('sub-ana'))

    expect(found?.toSnapshot()).toEqual(wishlist.toSnapshot())
  })

  it('devuelve null para un cliente sin lista', async () => {
    expect(await repository.findByCustomer(CustomerId.create('sub-sin-lista'))).toBeNull()
  })

  /**
   * `save` reemplaza la lista entera: es el mismo contrato que
   * `PostgresOrderRepository`, y la unica forma de que retirar una referencia
   * quede reflejada de verdad en el almacen.
   */
  it('retirar una referencia y guardar la deja fuera del almacen', async () => {
    const wishlist = buildWishlist('sub-bruno', ['sku-queda', 'sku-se-va'])
    await repository.save(wishlist)

    wishlist.remove(Sku.create('sku-se-va'))
    await repository.save(wishlist)

    const found = await repository.findByCustomer(CustomerId.create('sub-bruno'))

    expect(found?.toSnapshot().skus).toEqual(['sku-queda'])
  })

  it('vaciar la lista por completo la deja como si nunca hubiera existido', async () => {
    const wishlist = buildWishlist('sub-carla', ['unica-referencia'])
    await repository.save(wishlist)

    wishlist.remove(Sku.create('unica-referencia'))
    await repository.save(wishlist)

    expect(await repository.findByCustomer(CustomerId.create('sub-carla'))).toBeNull()
  })

  it('no filtra al almacen una mutacion sin guardar', async () => {
    const wishlist = buildWishlist('sub-diego', ['sku-guardada'])
    await repository.save(wishlist)

    wishlist.add(Sku.create('sku-fantasma'))

    const found = await repository.findByCustomer(CustomerId.create('sub-diego'))

    expect(found?.toSnapshot().skus).toEqual(['sku-guardada'])
  })

  it('no mezcla la lista de un cliente con la de otro', async () => {
    await repository.save(buildWishlist('sub-multiple-1', ['sku-a']))
    await repository.save(buildWishlist('sub-multiple-2', ['sku-b', 'sku-c']))

    expect(
      (await repository.findByCustomer(CustomerId.create('sub-multiple-1')))?.toSnapshot().skus,
    ).toEqual(['sku-a'])
    expect(
      (await repository.findByCustomer(CustomerId.create('sub-multiple-2')))?.toSnapshot().skus,
    ).toEqual(['sku-b', 'sku-c'])
  })

  describe('Las restricciones viven en el motor, no solo en el codigo', () => {
    it('impide que la misma referencia aparezca dos veces para el mismo cliente', async () => {
      await repository.save(buildWishlist('sub-restriccion', ['sku-repetida']))

      await expect(
        db
          .insertInto('wishlist_items')
          .values({ customer_id: 'sub-restriccion', sku: 'sku-repetida' })
          .execute(),
      ).rejects.toThrow()
    })

    it.each([
      ['en mayusculas', 'SKU-MAYUSCULAS'],
      ['con espacios', 'sku con espacios'],
      ['vacia', ''],
    ])('rechaza una referencia %s', async (_caso, sku) => {
      await expect(
        db.insertInto('wishlist_items').values({ customer_id: 'sub-formato', sku }).execute(),
      ).rejects.toThrow()
    })
  })

  it('la migracion es idempotente: volver a aplicarla no cambia nada', async () => {
    const { applied, error } = await migrateToLatest(db)

    expect(error).toBeUndefined()
    expect(applied).toEqual([])
  })
})
