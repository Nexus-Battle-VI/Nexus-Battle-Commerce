import type { Kysely, Transaction } from 'kysely'

import { Order } from '../../../domain/entities/Order'
import {
  CustomerId,
  Money,
  OrderId,
  Quantity,
  Sku,
} from '../../../domain/value-objects/commerce-values'
import type { OrderRepositoryPort } from '../../../application/ports/OrderRepositoryPort'
import type { Database } from './schema'
import {
  toLineRows,
  toOrderRow,
  toRestorable,
  type OrderLineRow,
  type OrderRow,
  type RestorableOrder,
} from './mapping'

/**
 * Repositorio del agregado Order sobre PostgreSQL, con Kysely.
 *
 * Cada consulta esta escrita a la vista. No hay carga perezosa que pueda
 * disparar consultas dentro de un bucle sin que aparezcan en el codigo, que es
 * la razon por la que ADR-012 eligio un constructor de consultas y no un ORM.
 */
export class PostgresOrderRepository implements OrderRepositoryPort {
  private readonly db: Kysely<Database>

  constructor(db: Kysely<Database>) {
    this.db = db
  }

  /**
   * Guarda el agregado entero, pedido y lineas, en una sola transaccion.
   *
   * Las lineas se reemplazan por completo: el agregado es la autoridad sobre su
   * contenido, y un pedido tiene pocas lineas —nada que ver con los cientos de
   * mensajes de un hilo—, asi que borrar e insertar es lo mas simple que expresa
   * exactamente esa semantica. Sin transaccion, un fallo entre ambas operaciones
   * dejaria un pedido SIN LINEAS: un total de cero que nadie pidio.
   */
  async save(order: Order): Promise<void> {
    const snapshot = order.toSnapshot()
    const row = toOrderRow(snapshot)
    const lines = toLineRows(snapshot)

    await this.db.transaction().execute(async (trx) => {
      await trx
        .insertInto('orders')
        .values(row)
        .onConflict((oc) =>
          oc.column('id').doUpdateSet({
            customer_id: row.customer_id,
            status: row.status,
            currency: row.currency,
            updated_at: new Date(),
          }),
        )
        .execute()

      await PostgresOrderRepository.replaceLines(trx, snapshot.id, lines)
    })
  }

  private static async replaceLines(
    trx: Transaction<Database>,
    orderId: string,
    lines: readonly OrderLineRow[],
  ): Promise<void> {
    await trx.deleteFrom('order_lines').where('order_id', '=', orderId).execute()

    if (lines.length === 0) {
      // Un pedido en borrador puede no tener ninguna linea todavia. Insertar un
      // conjunto vacio seria SQL invalido, asi que se sale antes.
      return
    }

    await trx
      .insertInto('order_lines')
      .values([...lines])
      .execute()
  }

  async findById(id: OrderId): Promise<Order | null> {
    const row = await this.db
      .selectFrom('orders')
      .selectAll()
      .where('id', '=', id.value)
      .executeTakeFirst()

    if (row === undefined) {
      return null
    }

    const lines = await this.db
      .selectFrom('order_lines')
      .selectAll()
      .where('order_id', '=', id.value)
      .execute()

    return PostgresOrderRepository.hydrate(row, lines)
  }

  /**
   * Lee los pedidos de un cliente con sus lineas en DOS consultas, no en una por
   * pedido.
   *
   * Lo ingenuo seria recorrer los pedidos y pedir las lineas de cada uno: con
   * cincuenta pedidos son cincuenta y una consultas. Se traen todas las lineas
   * de los pedidos leidos de una vez y se agrupan en memoria.
   *
   * No hay paginacion porque el puerto no la ofrece todavia. Es una deuda
   * consciente: cuando el historial de un cliente crezca, esto habra que
   * acotarlo, y el cambio sera del puerto y de los casos de uso, no solo del
   * adaptador.
   */
  async findByCustomer(customerId: CustomerId): Promise<readonly Order[]> {
    const rows = await this.db
      .selectFrom('orders')
      .selectAll()
      .where('customer_id', '=', customerId.value)
      .orderBy('id')
      .execute()

    if (rows.length === 0) {
      return []
    }

    const lines = await this.db
      .selectFrom('order_lines')
      .selectAll()
      .where(
        'order_id',
        'in',
        rows.map((row) => row.id),
      )
      .execute()

    const byOrder = new Map<string, OrderLineRow[]>()

    for (const line of lines) {
      const bucket = byOrder.get(line.order_id)

      if (bucket === undefined) {
        byOrder.set(line.order_id, [line])
      } else {
        bucket.push(line)
      }
    }

    return rows.map((row) => PostgresOrderRepository.hydrate(row, byOrder.get(row.id) ?? []))
  }

  private static hydrate(row: OrderRow, lines: readonly OrderLineRow[]): Order {
    const restorable: RestorableOrder = toRestorable(row, lines)

    return Order.restore({
      id: OrderId.create(restorable.id),
      customerId: CustomerId.create(restorable.customerId),
      currency: restorable.currency,
      status: restorable.status,
      lines: restorable.lines.map((line) => ({
        sku: Sku.create(line.sku),
        // La moneda de la linea es la del pedido, siempre: no hay columna que
        // permita otra cosa, que es justo lo que se buscaba al no repetirla.
        unitPrice: Money.create(line.unitPriceAmount, restorable.currency),
        quantity: Quantity.create(line.quantity),
      })),
    })
  }
}
