/**
 * Puerto de transferencia al inventario del jugador.
 *
 * El inventario es OTRO bounded context (Player-Inventory, Team Alfa).
 * Commerce **no accede a su base de datos**: le pide la transferencia, igual
 * que le pregunta los precios a Catalog. Esa prohibicion es la que mantiene el
 * limite entre servicios.
 *
 * `transferId` es lo que hace la transferencia **idempotente**, y es la pieza
 * central de CA-02 de HU-59: «no debe existir perdida, duplicacion ni
 * transferencia parcial». Reintentar la misma compra tras un fallo entrega el
 * mismo `transferId`, y una segunda entrega con ese identificador no anade
 * nada. Sin el, el reintento duplicaria los productos.
 */
export interface InventoryGrantItem {
  readonly sku: string
  readonly quantity: number
}

export interface InventoryGrant {
  /** Identificador de la transferencia, que es el del pedido. */
  readonly transferId: string
  readonly ownerId: string
  readonly items: readonly InventoryGrantItem[]
}

export interface PlayerInventoryPort {
  /**
   * Entrega los productos al inventario del jugador.
   *
   * Debe ser idempotente respecto a `transferId`: dos llamadas con el mismo
   * identificador dejan el inventario como una sola.
   */
  grant(grant: InventoryGrant): Promise<void>
}

export const PLAYER_INVENTORY = Symbol('PlayerInventoryPort')
