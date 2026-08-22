import type {
  ProductPrice,
  ProductPricingPort,
} from '../../../application/ports/ProductPricingPort'

/**
 * Adaptador de precios con catalogo local.
 *
 * Es una implementacion completa del puerto sobre un catalogo en memoria, no
 * una simulacion del servicio Catalog. El adaptador HTTP real depende de que
 * ADR-006 defina la integracion entre contextos; hasta entonces Commerce puede
 * ejecutarse y verificarse de extremo a extremo sin acoplarse a esa decision.
 *
 * Lo que este adaptador NO hace, de forma deliberada, es acceder a la base de
 * datos de Catalog. Esa prohibicion es la que mantiene el limite entre ambos
 * servicios.
 */
export class LocalCatalogPricing implements ProductPricingPort {
  private readonly prices: Map<string, ProductPrice>

  constructor(prices: readonly ProductPrice[]) {
    this.prices = new Map(prices.map((price) => [price.sku, price]))
  }

  priceOf(sku: string): Promise<ProductPrice | null> {
    return Promise.resolve(this.prices.get(sku.trim().toLowerCase()) ?? null)
  }

  get size(): number {
    return this.prices.size
  }
}

/**
 * Catalogo de precios del alcance de Sprint 1. Las referencias coinciden con
 * las publicadas por el contexto Catalog.
 */
export const DEMO_PRICES: readonly ProductPrice[] = [
  { sku: 'espada-de-hierro', amount: 15_000, currency: 'COP' },
  { sku: 'arco-corto', amount: 12_000, currency: 'COP' },
  { sku: 'pocion-de-vida', amount: 2_000, currency: 'COP' },
  { sku: 'escudo-de-roble', amount: 9_500, currency: 'COP' },
]
