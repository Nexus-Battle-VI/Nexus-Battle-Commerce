import {
  CatalogUnavailableError,
  ProductNotInCatalogError,
  ProductSoldOutError,
  type CatalogAcquisition,
  type CatalogAcquisitionResult,
  type CatalogInventoryPort,
} from '../../../application/ports/CatalogInventoryPort'
import type { Logger } from '../../../infrastructure/observability/logger'
import {
  INTERNAL_SERVICE_HEADER,
  INTERNAL_SIGNATURE_HEADER,
  INTERNAL_TIMESTAMP_HEADER,
  signInternalRequest,
} from '../identity/internal-signature'

export interface CatalogInventoryClientOptions {
  readonly baseUrl: string
  readonly secret: string
  readonly serviceName: string
  readonly timeoutMs: number
  readonly logger: Logger
  readonly fetchImpl?: typeof fetch
}

const pathFor = (productRef: string): string =>
  `/api/internal/v1/catalog/products/${encodeURIComponent(productRef)}/acquisitions`

/**
 * Cliente del contrato interno de adquisición de Catalog (HU-34).
 *
 * CADA RESPUESTA SIGNIFICA UNA COSA DISTINTA Y NO SE MEZCLAN.
 *
 * - `409` es agotado: la petición era correcta y lo que falla es el estado del
 *   producto. Se puede explicar al comprador y se resuelve ampliando el tiraje.
 * - `404` es que el producto no existe en el catálogo canónico.
 * - Cualquier otra cosa —incluido `401`— es **indisponibilidad del contrato**,
 *   no ausencia de unidades. Confundirlas convertiría una caída de Catalog en
 *   la afirmación de que un producto está agotado, que es falsa, y mandaría a
 *   mirar el sitio equivocado.
 *
 * NO SE REGISTRA LA FIRMA NI EL SECRETO. Un registro con la firma convierte los
 * propios registros en el material que la protege.
 *
 * EL TIEMPO DE ESPERA ES EXPLÍCITO. Sin él, una petición colgada dejaría la
 * compra esperando hasta el tiempo de espera de la petición HTTP entrante, y el
 * síntoma sería una interfaz congelada en lugar de un rechazo claro.
 */
export class CatalogInventoryClient implements CatalogInventoryPort {
  private readonly fetchImpl: typeof fetch

  constructor(private readonly options: CatalogInventoryClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  async acquire(acquisition: CatalogAcquisition): Promise<CatalogAcquisitionResult> {
    const path = pathFor(acquisition.productRef)
    const body = {
      acquisitionId: acquisition.acquisitionId,
      playerId: acquisition.playerId,
    }
    const timestamp = String(Date.now())
    const signature = signInternalRequest(this.options.secret, {
      service: this.options.serviceName,
      method: 'POST',
      path,
      timestamp,
      body,
    })

    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort()
    }, this.options.timeoutMs)

    try {
      const response = await this.fetchImpl(`${this.options.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [INTERNAL_SERVICE_HEADER]: this.options.serviceName,
          [INTERNAL_TIMESTAMP_HEADER]: timestamp,
          [INTERNAL_SIGNATURE_HEADER]: signature,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })

      if (response.status === 409) {
        throw new ProductSoldOutError(acquisition.productRef)
      }

      if (response.status === 404) {
        throw new ProductNotInCatalogError(acquisition.productRef)
      }

      if (!response.ok) {
        this.options.logger.warn('catalog_inventory_respuesta_no_ok', {
          status: response.status,
        })

        throw new CatalogUnavailableError(`Catalog respondio ${String(response.status)}.`)
      }

      const payload: unknown = await response.json()

      if (typeof payload !== 'object' || payload === null || !('availableUnits' in payload)) {
        throw new CatalogUnavailableError('Respuesta ininteligible de Catalog.')
      }

      const { availableUnits } = payload

      if (availableUnits !== null && typeof availableUnits !== 'number') {
        throw new CatalogUnavailableError('Respuesta ininteligible de Catalog.')
      }

      return { availableUnits, soldOut: availableUnits === 0 }
    } catch (error: unknown) {
      // Los errores de dominio del contrato viajan tal cual: ya dicen lo que
      // paso. Envolverlos en indisponibilidad perderia justo la distincion que
      // este adaptador existe para conservar.
      if (
        error instanceof ProductSoldOutError ||
        error instanceof ProductNotInCatalogError ||
        error instanceof CatalogUnavailableError
      ) {
        throw error
      }

      const detalle = error instanceof Error ? error.message : String(error)
      this.options.logger.warn('catalog_inventory_fallo', { detail: detalle })

      throw new CatalogUnavailableError(detalle)
    } finally {
      clearTimeout(timer)
    }
  }
}
