import type {
  CatalogProduct,
  ProductPrice,
  ProductPricingPort,
} from '../../../application/ports/ProductPricingPort'
import { IntegrationUnavailableError } from '../../../application/ports/CommerceIntegrationPorts'

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/**
 * Categorias elegibles para el flujo de compra premium (contrato Infrastructure
 * `docs/contracts/ecommerce-integration-v1.md`, "Elegibilidad de comercializacion
 * premium", aclaracion del PO 2026-09-24). `ITEM` y `EPICA` quedan fuera de
 * E-commerce: siguen existiendo en Catalog/Player-Inventory/Missions, pero la
 * epica se obtiene por Mision/Master, nunca por compra. La autoridad de esta
 * regla vive aqui, en Commerce, no en Catalog ni en Web: no se agrega un campo
 * derivado (`ecommerceEligible`) ni un endpoint nuevo, se reutiliza el `type`
 * que `productOf()` ya recibe de la misma respuesta.
 */
const ECOMMERCE_ELIGIBLE_TYPES: ReadonlySet<string> = new Set([
  'HEROE',
  'HABILIDAD',
  'ARMA',
  'ARMADURA',
])

export class HttpCatalogPricing implements ProductPricingPort {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number,
    private readonly request: typeof fetch = fetch,
  ) {}

  async productOf(reference: string): Promise<CatalogProduct | null> {
    try {
      const response = await this.request(
        `${this.baseUrl}/api/v1/catalog/products/${encodeURIComponent(reference)}`,
        { signal: AbortSignal.timeout(this.timeoutMs) },
      )
      if (response.status === 404) return null
      if (!response.ok) throw new IntegrationUnavailableError('Catalog no esta disponible.')
      const data: unknown = await response.json()
      if (
        !record(data) ||
        typeof data.productId !== 'string' ||
        !UUID.test(data.productId) ||
        typeof data.sku !== 'string' ||
        typeof data.name !== 'string' ||
        typeof data.imageUrl !== 'string' ||
        typeof data.premium !== 'boolean' ||
        typeof data.type !== 'string' ||
        !['ACTIVE', 'SUSPENDED'].includes(String(data.lifecycleStatus)) ||
        (data.availableUnits !== null &&
          (!Number.isSafeInteger(data.availableUnits) || Number(data.availableUnits) < 0))
      ) {
        throw new IntegrationUnavailableError('Catalog devolvio un producto incompatible.')
      }
      const price = data.realMoneyPrice
      if (
        price !== null &&
        (!record(price) ||
          !Number.isSafeInteger(price.amount) ||
          Number(price.amount) < 1 ||
          !['COP', 'USD', 'EUR'].includes(String(price.currency)))
      )
        throw new IntegrationUnavailableError('Catalog devolvio un precio incompatible.')
      return {
        productId: data.productId,
        sku: data.sku,
        name: data.name,
        imageUrl: data.imageUrl,
        premium: data.premium,
        type: data.type,
        lifecycleStatus: data.lifecycleStatus as 'ACTIVE' | 'SUSPENDED',
        availableUnits: data.availableUnits as number | null,
        realMoneyPrice:
          price === null
            ? null
            : { amount: Number(price.amount), currency: String(price.currency) },
      }
    } catch (error: unknown) {
      if (error instanceof IntegrationUnavailableError) throw error
      throw new IntegrationUnavailableError('No se pudo consultar el contrato de Catalog.')
    }
  }

  async priceOf(reference: string): Promise<ProductPrice | null> {
    const product = await this.productOf(reference)
    if (
      product?.lifecycleStatus !== 'ACTIVE' ||
      !product.premium ||
      product.realMoneyPrice === null ||
      !ECOMMERCE_ELIGIBLE_TYPES.has(product.type ?? '')
    )
      return null
    return {
      productId: product.productId,
      sku: product.sku,
      name: product.name,
      imageUrl: product.imageUrl,
      availableUnits: product.availableUnits,
      type: product.type,
      ...product.realMoneyPrice,
    }
  }
}
