import type { Generated } from 'kysely'

/**
 * Esquema de la base de datos de Commerce, tipado para Kysely.
 *
 * **Es la unica fuente de verdad de los tipos de persistencia.** No hay paso de
 * generacion de codigo: lo que se declara aqui es lo que el compilador verifica
 * en cada consulta. Si una migracion anade una columna y esta interfaz no la
 * refleja, el codigo que la use no compila.
 *
 * Los nombres de columna son `snake_case`, que es la convencion de PostgreSQL.
 * La traduccion a la instantanea del agregado ocurre en `mapping.ts`, y ocurre
 * de forma explicita: no hay conversion automatica de nombres que sorprenda.
 */
export interface OrdersTable {
  readonly id: string

  /**
   * Cliente del pedido, tal y como lo declaro el testimonio verificado.
   *
   * Es un identificador de OTRO servicio y por eso no lleva clave foranea:
   * Commerce no puede referenciar la tabla de cuentas de Account, ni debe.
   */
  readonly customer_id: string

  readonly status: string

  /**
   * La moneda vive en el pedido y NO en cada linea.
   *
   * El dominio exige que todas las lineas compartan la moneda del pedido
   * (`Order.restore` lo rechaza si no). Repetir la columna por linea permitiria
   * escribir un estado que el dominio no admite y que solo se descubriria al
   * leerlo. Con una sola columna, esa divergencia no se puede ni representar.
   */
  readonly currency: string

  readonly created_at: Generated<Date>
  readonly updated_at: Generated<Date>
}

/**
 * Lineas del pedido.
 *
 * NO se guardan ni el subtotal de la linea ni el total del pedido. Ambos son
 * **derivados**: el agregado los calcula en `toSnapshot` y `restore` ni siquiera
 * los acepta. Persistirlos crearia una segunda fuente de verdad que puede
 * divergir del calculo, y un total que no cuadra con sus lineas es peor que no
 * tener total.
 */
export interface OrderLinesTable {
  /** Clave foranea DENTRO del mismo servicio, que es lo que si esta permitido. */
  readonly order_id: string

  readonly sku: string

  /**
   * Importe en la unidad minima de la moneda, entero y no negativo.
   *
   * Es `bigint` y no `integer`: un pedido en COP supera los 2.147.483.647 sin
   * ninguna dificultad, y desbordar un importe es la clase de error que nadie
   * detecta hasta que cuadra la caja. `bigint` llega desde PostgreSQL como
   * cadena, y `mapping.ts` lo convierte comprobando que sigue siendo exacto en
   * JavaScript.
   */
  readonly unit_price_amount: string

  readonly quantity: number
}

/**
 * Referencias que un cliente desea.
 *
 * Sin `id` propio: la clave es (cliente, referencia), que es exactamente lo
 * que `Wishlist.add` trata como una sola posicion posible. No hay columna de
 * "adquirido": esa marca se deriva de `orders` en el momento de leer, y
 * guardarla aqui crearia una segunda fuente de verdad.
 */
export interface WishlistItemsTable {
  readonly customer_id: string
  readonly sku: string
  readonly created_at: Generated<Date>
}

export interface Database {
  readonly orders: OrdersTable
  readonly order_lines: OrderLinesTable
  readonly wishlist_items: WishlistItemsTable
}
