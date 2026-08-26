import { OrderStatus } from '../../../domain/entities/Order'
import { Money, Quantity } from '../../../domain/value-objects/commerce-values'
import type { OrderSnapshot } from '../../../domain/entities/Order'

/**
 * Traduccion entre filas de PostgreSQL y la instantanea del agregado.
 *
 * Vive aparte del repositorio y es **puro** a proposito: es la parte del
 * adaptador donde de verdad se puede equivocar uno, y sacarla del repositorio
 * permite probarla sin base de datos ni contenedor.
 */

export class PersistenceMappingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PersistenceMappingError'
  }
}

export interface OrderRow {
  readonly id: string
  readonly customer_id: string
  readonly status: string
  readonly currency: string
}

export interface OrderLineRow {
  readonly order_id: string
  readonly sku: string
  readonly unit_price_amount: string
  readonly quantity: number
}

/**
 * Linea ya traducida, con el importe convertido a numero.
 *
 * No es `OrderLineSnapshot` porque aquel incluye el subtotal, que es derivado y
 * no se persiste. Lo que se lee del almacen es lo minimo con lo que el agregado
 * puede reconstruirse; el resto lo calcula el.
 */
export interface RestorableLine {
  readonly sku: string
  readonly unitPriceAmount: number
  readonly quantity: number
}

export interface RestorableOrder {
  readonly id: string
  readonly customerId: string
  readonly status: OrderStatus
  readonly currency: string
  readonly lines: readonly RestorableLine[]
}

const STATUSES: readonly string[] = Object.values(OrderStatus)

/**
 * Convierte un `bigint` de PostgreSQL en un numero de JavaScript.
 *
 * El controlador de `pg` entrega `bigint` como cadena, y no por capricho: un
 * entero de 64 bits no cabe en el numero de JavaScript, que es exacto solo hasta
 * 2^53 - 1. Pasarlo por `Number()` a secas **redondearia en silencio** un
 * importe grande, que es justo lo que no puede ocurrir con dinero.
 *
 * Se comprueba que la conversion sea exacta comparando el texto de vuelta. Si no
 * lo es, se falla: un importe redondeado es peor que un error.
 */
const toExactAmount = (raw: string, contexto: string): number => {
  const parsed = Number(raw)

  if (!Number.isInteger(parsed) || String(parsed) !== raw.trim()) {
    throw new PersistenceMappingError(
      `${contexto} tiene un importe que no se puede representar con exactitud: "${raw}".`,
    )
  }

  return parsed
}

/**
 * Construye lo necesario para reconstituir el agregado.
 *
 * Valida lo que lee en lugar de confiar en la columna. Puede parecer excesivo
 * —la base de datos tiene sus propias restricciones— pero una fila escrita por
 * una version anterior del esquema, o por una migracion a medias, llegaria aqui
 * sin que nada la detuviera. Fallar al leerla es preferible a construir un
 * agregado con un estado que el dominio no reconoce.
 */
export const toRestorable = (row: OrderRow, lines: readonly OrderLineRow[]): RestorableOrder => {
  if (!STATUSES.includes(row.status)) {
    throw new PersistenceMappingError(
      `El pedido ${row.id} tiene un estado desconocido: "${row.status}".`,
    )
  }

  if (!Money.SUPPORTED_CURRENCIES.includes(row.currency)) {
    throw new PersistenceMappingError(
      `El pedido ${row.id} esta en una moneda que el dominio no admite: "${row.currency}".`,
    )
  }

  return {
    id: row.id,
    customerId: row.customer_id,
    status: row.status as OrderStatus,
    currency: row.currency,
    // Por SKU, que es el mismo orden que produce `toSnapshot`. Sin ordenar, dos
    // lecturas del mismo pedido podrian devolver las lineas en distinto orden.
    lines: [...lines]
      .sort((a, b) => a.sku.localeCompare(b.sku))
      .map((line) => ({
        sku: line.sku,
        unitPriceAmount: toExactAmount(
          line.unit_price_amount,
          `La linea ${line.sku} del pedido ${row.id}`,
        ),
        quantity: line.quantity,
      })),
  }
}

/** Descompone la instantanea en la fila de `orders`. */
export const toOrderRow = (snapshot: OrderSnapshot): OrderRow => ({
  id: snapshot.id,
  customer_id: snapshot.customerId,
  status: snapshot.status,
  currency: snapshot.currency,
})

/**
 * Descompone las lineas en filas.
 *
 * El subtotal de la instantanea se descarta a proposito: es derivado, y guardarlo
 * lo convertiria en una segunda fuente de verdad. El importe se escribe como
 * cadena porque la columna es `bigint`.
 */
export const toLineRows = (snapshot: OrderSnapshot): readonly OrderLineRow[] =>
  snapshot.lines.map((line) => {
    if (line.quantity < 1 || line.quantity > Quantity.MAX) {
      throw new PersistenceMappingError(
        `La linea ${line.sku} del pedido ${snapshot.id} tiene una cantidad fuera de rango: ${String(line.quantity)}.`,
      )
    }

    return {
      order_id: snapshot.id,
      sku: line.sku,
      unit_price_amount: String(line.unitPriceAmount),
      quantity: line.quantity,
    }
  })
