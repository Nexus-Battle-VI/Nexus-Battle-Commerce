import type { SavedCartSnapshot } from '../../domain/entities/SavedCart'

export interface SavedCartItemDto {
  readonly sku: string
  readonly unitPrice: number
  readonly quantity: number
  readonly subtotal: number
}

export interface SavedCartDto {
  readonly currency: string
  readonly total: number
  readonly itemCount: number
  readonly items: readonly SavedCartItemDto[]
}

/**
 * Subtotales y total se calculan aqui, no se persisten, por la misma razon que
 * en el pedido: un total guardado puede divergir de sus lineas.
 */
export const toSavedCartDto = (snapshot: SavedCartSnapshot): SavedCartDto => ({
  currency: snapshot.currency,
  total: snapshot.items.reduce((sum, item) => sum + item.unitPriceAmount * item.quantity, 0),
  itemCount: snapshot.items.reduce((sum, item) => sum + item.quantity, 0),
  items: snapshot.items.map((item) => ({
    sku: item.sku,
    unitPrice: item.unitPriceAmount,
    quantity: item.quantity,
    subtotal: item.unitPriceAmount * item.quantity,
  })),
})
