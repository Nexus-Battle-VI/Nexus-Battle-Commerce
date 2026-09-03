/**
 * Puerto de consulta de precios al contexto Catalog.
 *
 * Commerce **no accede a la base de datos de Catalog**. Pregunta por la API y
 * conserva el precio devuelto dentro de la linea del pedido, de modo que un
 * cambio posterior en el catalogo no altera lo que la persona ya compro.
 *
 * La implementacion HTTP real depende de que ADR-006 defina la integracion
 * entre contextos. En Foundation opera un adaptador con catalogo local, que es
 * una implementacion completa del puerto y no una simulacion del servicio.
 */
export interface ProductPrice {
  readonly productId?: string
  readonly name?: string
  readonly imageUrl?: string
  readonly availableUnits?: number | null
  readonly sku: string
  readonly amount: number
  readonly currency: string
}

export interface ProductPricingPort {
  /** Devuelve `null` cuando el producto no existe o no esta a la venta. */
  priceOf(sku: string): Promise<ProductPrice | null>
  productOf?(reference: string): Promise<CatalogProduct | null>
}

export interface CatalogProduct {
  readonly productId: string
  readonly sku: string
  readonly name: string
  readonly imageUrl: string
  readonly premium: boolean
  readonly lifecycleStatus: 'ACTIVE' | 'SUSPENDED'
  readonly availableUnits: number | null
  readonly realMoneyPrice: { readonly amount: number; readonly currency: string } | null
}

export const PRODUCT_PRICING = Symbol('ProductPricingPort')
