import { ApiProperty } from '@nestjs/swagger'
import { IsIn, IsInt, IsString, Length, Matches, Max, Min } from 'class-validator'

const KEBAB = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/

/**
 * Ninguna peticion declara quien la realiza.
 *
 * `customerId` estuvo aqui y se ha retirado: era un dato que el cliente
 * afirmaba, de modo que cualquiera podia abrir y confirmar pedidos a nombre de
 * otra persona. Ahora sale del `sub` del testimonio verificado.
 *
 * Con `forbidNonWhitelisted`, enviarlo ahora produce 400: el intento de
 * suplantacion se rechaza de forma ruidosa en lugar de aceptarse en silencio.
 */
export class CreateOrderRequest {
  @ApiProperty({ example: 'COP', enum: ['COP', 'USD', 'EUR'] })
  @IsIn(['COP', 'USD', 'EUR'])
  currency!: string
}

/**
 * Contrato de alta de linea.
 *
 * **No incluye el precio de forma deliberada.** El precio lo determina el
 * catalogo, no quien compra. Aceptarlo desde la peticion permitiria fijar el
 * importe de un pedido propio.
 */
export class AddLineRequest {
  @ApiProperty({ example: 'espada-de-hierro' })
  @IsString()
  @Matches(KEBAB, { message: 'La referencia debe estar en kebab-case.' })
  sku!: string

  @ApiProperty({ example: 2, minimum: 1, maximum: 999 })
  @IsInt()
  @Min(1)
  @Max(999)
  quantity!: number
}

export class CancelOrderRequest {
  @ApiProperty({ example: 'Solicitado por la persona cliente', maxLength: 200 })
  @IsString()
  @Length(1, 200)
  reason!: string
}

export class OrderLineResponse {
  @ApiProperty({ example: 'espada-de-hierro' })
  readonly sku!: string

  @ApiProperty({ example: 15000, description: 'Importe unitario en la unidad minima de la moneda' })
  readonly unitPrice!: number

  @ApiProperty({ example: 2 })
  readonly quantity!: number

  @ApiProperty({ example: 30000 })
  readonly subtotal!: number
}

export class OrderResponse {
  @ApiProperty({ example: 'ord-0b1d5b0e' })
  readonly id!: string

  @ApiProperty({ example: 'acc-0b1d5b0e' })
  readonly customerId!: string

  @ApiProperty({ example: 'DRAFT', enum: ['DRAFT', 'CONFIRMED', 'CANCELLED'] })
  readonly status!: string

  @ApiProperty({ example: 'COP' })
  readonly currency!: string

  @ApiProperty({ example: 30000, description: 'Suma de los subtotales de las lineas' })
  readonly total!: number

  @ApiProperty({ type: OrderLineResponse, isArray: true })
  readonly lines!: readonly OrderLineResponse[]
}
