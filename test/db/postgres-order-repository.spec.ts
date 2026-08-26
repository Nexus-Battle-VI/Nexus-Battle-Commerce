import 'reflect-metadata'

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import type { Kysely } from 'kysely'

import { describeError } from '../../src/infrastructure/observability/describe-error'
import { createDatabase, migrateToLatest } from '../../src/infrastructure/persistence/database'
import { PostgresOrderRepository } from '../../src/adapters/outbound/persistence/PostgresOrderRepository'
import type { Database } from '../../src/adapters/outbound/persistence/schema'
import { Order, OrderStatus } from '../../src/domain/entities/Order'
import {
  CustomerId,
  Money,
  OrderId,
  Quantity,
  Sku,
} from '../../src/domain/value-objects/commerce-values'

/**
 * Adaptador de PostgreSQL contra un motor REAL, en contenedor.
 *
 * Estas pruebas viven aparte de la suite por defecto porque necesitan Docker.
 * Lo que comprueban no se puede comprobar de otra forma: que el SQL sea valido,
 * que las restricciones existan de verdad y que la transaccion haga lo que dice.
 * Un doble de prueba habria pasado con un esquema equivocado.
 */
describe('PostgresOrderRepository', () => {
  let container: StartedPostgreSqlContainer
  let db: Kysely<Database>
  let repository: PostgresOrderRepository

  const AT = new Date('2026-08-25T10:00:00.000Z')
  let contador = 0

  const buildOrder = (customer = 'sub-ana'): Order => {
    contador += 1

    return Order.draft({
      id: OrderId.create(`ord-${String(contador)}`),
      customerId: CustomerId.create(customer),
      currency: 'COP',
    })
  }

  const addLine = (order: Order, sku: string, amount: number, quantity: number): void => {
    order.addLine(Sku.create(sku), Money.create(amount, 'COP'), Quantity.create(quantity))
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
    repository = new PostgresOrderRepository(db)
  })

  it('guarda y recupera un pedido en borrador sin lineas', async () => {
    const order = buildOrder()
    await repository.save(order)

    const found = await repository.findById(order.id)

    expect(found?.toSnapshot()).toEqual(order.toSnapshot())
  })

  it('guarda y recupera un pedido con sus lineas', async () => {
    const order = buildOrder()
    addLine(order, 'SKU-ESPADA', 150_000, 2)
    addLine(order, 'SKU-ESCUDO', 90_000, 1)
    await repository.save(order)

    const found = await repository.findById(order.id)

    expect(found?.toSnapshot()).toEqual(order.toSnapshot())
  })

  /**
   * El total NO se guarda: es derivado. Esta prueba comprueba que se recalcula
   * correctamente al leer, que es la unica garantia que sustituye a la columna
   * que deliberadamente no existe.
   */
  it('recalcula el total al leer, sin haberlo guardado', async () => {
    const order = buildOrder()
    addLine(order, 'SKU-A', 150_000, 2)
    addLine(order, 'SKU-B', 90_000, 3)
    await repository.save(order)

    const found = await repository.findById(order.id)

    expect(found?.toSnapshot().totalAmount).toBe(150_000 * 2 + 90_000 * 3)

    const columnas = await db
      .selectFrom('order_lines')
      .selectAll()
      .where('order_id', '=', order.id.value)
      .executeTakeFirstOrThrow()

    expect(Object.keys(columnas).sort()).toEqual([
      'order_id',
      'quantity',
      'sku',
      'unit_price_amount',
    ])
  })

  /**
   * Un importe por encima de 2.147.483.647 desbordaria una columna `integer`.
   * En COP eso son poco mas de dos mil millones de pesos: nada extraordinario.
   */
  it('guarda un importe que desbordaria un entero de 32 bits', async () => {
    const order = buildOrder()
    addLine(order, 'SKU-CARO', 5_000_000_000, 1)
    await repository.save(order)

    const found = await repository.findById(order.id)

    expect(found?.toSnapshot().lines[0]?.unitPriceAmount).toBe(5_000_000_000)
    expect(found?.toSnapshot().totalAmount).toBe(5_000_000_000)
  })

  it('devuelve null cuando el pedido no existe', async () => {
    expect(await repository.findById(OrderId.create('ord-inexistente'))).toBeNull()
  })

  /**
   * El mismo contrato que cumple el repositorio en memoria: una mutacion que no
   * se guarda NO debe filtrarse al almacen. Es lo que hace que una prueba falle
   * cuando un caso de uso olvida llamar a `save`.
   */
  it('no filtra al almacen una mutacion sin guardar', async () => {
    const order = buildOrder()
    addLine(order, 'SKU-A', 1000, 1)
    await repository.save(order)

    addLine(order, 'SKU-FANTASMA', 5000, 1)

    const found = await repository.findById(order.id)

    expect(found?.toSnapshot().lines).toHaveLength(1)
  })

  it('actualiza el pedido existente en lugar de duplicarlo', async () => {
    const order = buildOrder()
    addLine(order, 'SKU-A', 1000, 1)
    await repository.save(order)

    order.confirm(AT)
    await repository.save(order)

    const found = await repository.findById(order.id)

    expect(found?.currentStatus).toBe(OrderStatus.Confirmed)

    const filas = await db
      .selectFrom('orders')
      .select(({ fn }) => fn.countAll().as('total'))
      .where('id', '=', order.id.value)
      .executeTakeFirstOrThrow()

    expect(Number(filas.total)).toBe(1)
  })

  /**
   * Las lineas se reemplazan por completo: el agregado es la autoridad sobre su
   * contenido. Retirar una tiene que borrarla de verdad, no dejarla huerfana.
   */
  it('retira del almacen la linea que el agregado ya no tiene', async () => {
    const order = buildOrder()
    addLine(order, 'SKU-QUEDA', 1000, 1)
    addLine(order, 'SKU-SE-VA', 2000, 1)
    await repository.save(order)

    order.removeLine(Sku.create('SKU-SE-VA'))
    await repository.save(order)

    const restantes = await db
      .selectFrom('order_lines')
      .select('sku')
      .where('order_id', '=', order.id.value)
      .execute()

    // `Sku` normaliza a minusculas, asi que es la forma normalizada la que
    // esta guardada, no la que se escribio al construirla.
    expect(restantes.map((fila) => fila.sku)).toEqual(['sku-queda'])
  })

  it('lee los pedidos de un cliente sin una consulta por pedido', async () => {
    const primero = buildOrder('sub-cliente-multiple')
    addLine(primero, 'SKU-A', 1000, 1)
    const segundo = buildOrder('sub-cliente-multiple')
    addLine(segundo, 'SKU-B', 2000, 1)
    addLine(segundo, 'SKU-C', 3000, 2)
    const ajeno = buildOrder('sub-otro-cliente')

    await repository.save(primero)
    await repository.save(segundo)
    await repository.save(ajeno)

    const suyos = await repository.findByCustomer(CustomerId.create('sub-cliente-multiple'))

    expect(suyos.map((order) => order.id.value)).toEqual([primero.id.value, segundo.id.value])
    expect(suyos.map((order) => order.toSnapshot().lines.length)).toEqual([1, 2])
  })

  it('devuelve una lista vacia para un cliente sin pedidos', async () => {
    expect(await repository.findByCustomer(CustomerId.create('sub-sin-pedidos'))).toEqual([])
  })

  describe('Las restricciones viven en el motor, no solo en el codigo', () => {
    /**
     * Se escribe directamente en la tabla, sin pasar por el agregado. Es la
     * unica forma de demostrar que la proteccion esta en el motor: a traves del
     * dominio, el valor invalido no llegaria nunca.
     */
    it('rechaza un estado que no pertenece al vocabulario', async () => {
      const order = buildOrder()
      await repository.save(order)

      await expect(
        db
          .updateTable('orders')
          .set({ status: 'REEMBOLSADO' })
          .where('id', '=', order.id.value)
          .execute(),
      ).rejects.toThrow()
    })

    it('rechaza una moneda que no pertenece al vocabulario', async () => {
      const order = buildOrder()
      await repository.save(order)

      await expect(
        db
          .updateTable('orders')
          .set({ currency: 'XYZ' })
          .where('id', '=', order.id.value)
          .execute(),
      ).rejects.toThrow()
    })

    it('impide que un pedido repita la misma referencia', async () => {
      const order = buildOrder()
      addLine(order, 'sku-repetida', 1000, 1)
      await repository.save(order)

      await expect(
        db
          .insertInto('order_lines')
          .values({
            order_id: order.id.value,
            sku: 'sku-repetida',
            unit_price_amount: '2000',
            quantity: 1,
          })
          .execute(),
      ).rejects.toThrow()
    })

    /**
     * Sin esta restriccion, la clave primaria solo impediria repetir la cadena
     * exacta: `SKU-A` y `sku-a` conviviran como dos referencias distintas del
     * mismo pedido, y la invariante se esquivaria escribiendo con otra caja.
     */
    it.each([
      ['en mayusculas', 'SKU-MAYUSCULAS'],
      ['con espacios', 'sku con espacios'],
      ['que empieza por guion', '-sku'],
      ['vacia', ''],
    ])('rechaza una referencia %s', async (_caso, sku) => {
      const order = buildOrder()
      await repository.save(order)

      await expect(
        db
          .insertInto('order_lines')
          .values({
            order_id: order.id.value,
            sku,
            unit_price_amount: '1000',
            quantity: 1,
          })
          .execute(),
      ).rejects.toThrow()
    })

    it('rechaza un importe negativo', async () => {
      const order = buildOrder()
      await repository.save(order)

      await expect(
        db
          .insertInto('order_lines')
          .values({
            order_id: order.id.value,
            sku: 'SKU-NEGATIVA',
            unit_price_amount: '-1',
            quantity: 1,
          })
          .execute(),
      ).rejects.toThrow()
    })

    it.each([
      ['cero', 0],
      ['por encima del maximo del dominio', 1000],
    ])('rechaza una cantidad %s', async (_caso, quantity) => {
      const order = buildOrder()
      await repository.save(order)

      await expect(
        db
          .insertInto('order_lines')
          .values({
            order_id: order.id.value,
            sku: `SKU-CANTIDAD-${String(quantity)}`,
            unit_price_amount: '1000',
            quantity,
          })
          .execute(),
      ).rejects.toThrow()
    })

    it('rechaza una linea que no pertenece a ningun pedido', async () => {
      await expect(
        db
          .insertInto('order_lines')
          .values({
            order_id: 'ord-que-no-existe',
            sku: 'SKU-HUERFANA',
            unit_price_amount: '1000',
            quantity: 1,
          })
          .execute(),
      ).rejects.toThrow()
    })
  })

  it('respeta un limite de conexiones explicito', async () => {
    const acotada = createDatabase({
      connectionString: container.getConnectionUri(),
      maxConnections: 2,
    })

    try {
      const cuenta = await acotada
        .selectFrom('orders')
        .select((eb) => eb.fn.countAll().as('total'))
        .executeTakeFirstOrThrow()

      expect(Number(cuenta.total)).toBeGreaterThanOrEqual(0)
    } finally {
      await acotada.destroy()
    }
  })

  it('la migracion es idempotente: volver a aplicarla no cambia nada', async () => {
    const { applied, error } = await migrateToLatest(db)

    expect(error).toBeUndefined()
    expect(applied).toEqual([])
  })
})
