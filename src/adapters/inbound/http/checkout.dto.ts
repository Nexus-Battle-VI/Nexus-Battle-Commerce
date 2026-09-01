import { ApiProperty } from '@nestjs/swagger'
import { IsNotEmpty, IsString, Matches, MaxLength, MinLength } from 'class-validator'

import { OrderResponse } from './orders.dto'

/**
 * Formulario de pago simulado.
 *
 * Son los **cuatro datos que HU-59 documenta**, y solo esos. La historia dice
 * de forma expresa que no establece marcas de tarjeta, longitudes exactas,
 * algoritmos de validacion ni bancos, asi que aqui no se valida Luhn, ni
 * marca, ni caducidad real: se comprueba que vengan informados y con una forma
 * reconocible, que es lo que CA-02 exige («falta uno de los datos
 * documentados» debe impedir la compra).
 *
 * Ninguno de estos valores se persiste ni se registra en ningun momento.
 */
export class PaymentRequestBody {
  @ApiProperty({ example: 'Ana Gomez', minLength: 2, maxLength: 120 })
  @IsString()
  @IsNotEmpty({ message: 'El nombre del titular es obligatorio.' })
  @MinLength(2)
  @MaxLength(120)
  holder!: string

  @ApiProperty({ example: '4111111111111111', description: 'Solo digitos y separadores' })
  @IsString()
  @Matches(/^[0-9][0-9 -]{10,24}$/, {
    message: 'El numero de tarjeta debe contener solo digitos, espacios o guiones.',
  })
  number!: string

  @ApiProperty({ example: '12/30', description: 'MM/AA' })
  @IsString()
  @Matches(/^(0[1-9]|1[0-2])\/\d{2}$/, {
    message: 'La fecha de vencimiento debe tener el formato MM/AA.',
  })
  expiry!: string

  @ApiProperty({ example: '123' })
  @IsString()
  @Matches(/^\d{3,4}$/, { message: 'El codigo de seguridad debe tener tres o cuatro digitos.' })
  securityCode!: string
}

export class PaymentResponse {
  @ApiProperty({ type: OrderResponse, description: 'El pedido, ya confirmado' })
  readonly order!: OrderResponse

  @ApiProperty({ example: 'sim-8f1c...', description: 'Referencia de la transaccion simulada' })
  readonly paymentReference!: string

  @ApiProperty({ example: '1111', description: 'Cuatro ultimos digitos. Nunca el numero completo' })
  readonly maskedCard!: string

  @ApiProperty({
    example: false,
    description: 'Siempre false: el flujo es academico y no ejecuta cobros reales',
  })
  readonly realMoneyMoved!: boolean
}
