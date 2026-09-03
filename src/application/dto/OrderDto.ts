import type { OrderSnapshot } from '../../domain/entities/Order'

export interface OrderLineDto {
  readonly productId?: string
  readonly name?: string
  readonly imageUrl?: string
  readonly sku: string
  readonly unitPrice: number
  readonly quantity: number
  readonly subtotal: number
}

export interface OrderDto {
  readonly version?: number
  readonly id: string
  readonly customerId: string
  readonly status: string
  readonly currency: string
  readonly total: number
  /** Unidades en el carrito: lo que muestra la vista minimizada. */
  readonly itemCount: number
  readonly lines: readonly OrderLineDto[]
}

export const toOrderDto = (snapshot: OrderSnapshot): OrderDto => ({
  id: snapshot.id,
  version: snapshot.version ?? 0,
  customerId: snapshot.customerId,
  status: snapshot.status,
  currency: snapshot.currency,
  total: snapshot.totalAmount,
  itemCount: snapshot.itemCount,
  lines: snapshot.lines.map((line) => ({
    ...(line.productId === undefined ? {} : { productId: line.productId }),
    ...(line.name === undefined ? {} : { name: line.name }),
    ...(line.imageUrl === undefined ? {} : { imageUrl: line.imageUrl }),
    sku: line.catalogSku ?? line.sku,
    unitPrice: line.unitPriceAmount,
    quantity: line.quantity,
    subtotal: line.subtotalAmount,
  })),
})
