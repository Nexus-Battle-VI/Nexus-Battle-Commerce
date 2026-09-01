import { ApiProperty } from '@nestjs/swagger'

export class SavedCartItemResponse {
  @ApiProperty({ example: 'espada-de-hierro' })
  readonly sku!: string

  @ApiProperty({ example: 15000, description: 'Precio congelado al guardar, no el vigente' })
  readonly unitPrice!: number

  @ApiProperty({ example: 2 })
  readonly quantity!: number

  @ApiProperty({ example: 30000 })
  readonly subtotal!: number
}

export class SavedCartResponse {
  @ApiProperty({ example: 'COP', enum: ['COP', 'USD', 'EUR'] })
  readonly currency!: string

  @ApiProperty({ example: 30000 })
  readonly total!: number

  @ApiProperty({ example: 2, description: 'Suma de las cantidades guardadas' })
  readonly itemCount!: number

  @ApiProperty({ type: [SavedCartItemResponse] })
  readonly items!: readonly SavedCartItemResponse[]
}
