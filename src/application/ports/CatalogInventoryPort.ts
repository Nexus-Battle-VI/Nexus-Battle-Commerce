/**
 * Puerto de descuento de inventario del catálogo (HU-34).
 *
 * EL DECREMENTO ES EXCLUSIVO DE CATALOG. Commerce **no escribe** sobre
 * `unidadesDisponibles`: lo solicita, igual que le pregunta los precios. Esa
 * prohibición es la que mantiene el límite entre servicios, y es literal en la
 * historia: «ningún otro servicio puede escribir directamente sobre
 * unidadesDisponibles».
 *
 * `acquisitionId` es lo que hace la petición **idempotente**, y es la misma
 * idea que `transferId` en la transferencia al inventario: un reintento con el
 * mismo identificador no descuenta una segunda unidad. Sin él, un tiempo de
 * espera agotado con la petición ya procesada al otro lado agotaría el producto
 * antes de lo que debía, y ese error no se ve — nadie recibe un fallo.
 */
export interface CatalogAcquisition {
  /** Identificador de la adquisición. Un reintento debe repetirlo. */
  readonly acquisitionId: string
  /** Referencia del producto. Hoy es el SKU; ver ADR-006. */
  readonly productRef: string
  readonly playerId: string
}

export interface CatalogAcquisitionResult {
  /** Unidades restantes. `null` en tiraje infinito. */
  readonly availableUnits: number | null
  readonly soldOut: boolean
}

/** El producto no tiene unidades disponibles: la compra no puede completarse. */
export class ProductSoldOutError extends Error {
  constructor(readonly productRef: string) {
    super(`El producto "${productRef}" está agotado.`)
    this.name = 'ProductSoldOutError'
  }
}

/** El producto no existe en el catálogo canónico. */
export class ProductNotInCatalogError extends Error {
  constructor(readonly productRef: string) {
    super(`El producto "${productRef}" no existe en el catálogo.`)
    this.name = 'ProductNotInCatalogError'
  }
}

/** No se pudo consultar a Catalog. NO significa que haya unidades. */
export class CatalogUnavailableError extends Error {
  constructor(detail: string) {
    super(`No se pudo descontar del catálogo: ${detail}`)
    this.name = 'CatalogUnavailableError'
  }
}

export interface CatalogInventoryPort {
  /**
   * Descuenta una unidad del producto.
   *
   * Debe ser idempotente respecto a `acquisitionId`.
   *
   * Lanza al no poder completarse. NO devuelve un booleano: distinguir
   * «agotado» de «no existe» de «no se pudo preguntar» es lo que permite
   * responder al comprador algo cierto, y un booleano lo perdería.
   */
  acquire(acquisition: CatalogAcquisition): Promise<CatalogAcquisitionResult>
}

export const CATALOG_INVENTORY = Symbol('CatalogInventoryPort')
