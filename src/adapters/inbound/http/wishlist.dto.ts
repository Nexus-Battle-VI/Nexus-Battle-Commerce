import { ApiProperty } from '@nestjs/swagger'

export class WishlistItemResponse {
  @ApiProperty({ example: 'espada-de-hierro' })
  readonly sku!: string

  @ApiProperty({ example: true, description: 'Si el cliente tiene esta referencia en su lista' })
  readonly enDeseos!: boolean

  @ApiProperty({
    example: false,
    description: 'Si el cliente ya la adquirio, segun sus pedidos confirmados',
  })
  readonly adquirido!: boolean
}
