import { ApiProperty } from '@nestjs/swagger'
import { IsInt, IsOptional, IsString, Matches, Min } from 'class-validator'
import { OrderResponse } from './orders.dto'

/**
 * HU-59 exige cuatro datos presentes y no inventa reglas bancarias: nada de
 * Luhn, marca de tarjeta (Visa/Mastercard/...) ni banco emisor. Lo que si se
 * valida aqui es la FORMA de cada campo (que "parezca" el dato que dice ser),
 * no su validez financiera. `SimulatedPaymentGateway` conserva su propio
 * chequeo de "no vacio" como ultima red para llamadas que no pasan por este
 * borde HTTP (recuperacion, pruebas de caso de uso); esta es la unica capa
 * que valida forma.
 */
export class PaymentRequestBody {
  @ApiProperty({ example: 'Ana Gomez' })
  @IsString()
  @Matches(/\S/, { message: 'El titular es obligatorio.' })
  holder!: string
  @ApiProperty({ example: '4111111111111111' })
  @IsString()
  @Matches(/^\d(?: ?\d){12,18}$/, {
    message: 'El numero de tarjeta debe tener entre 13 y 19 digitos.',
  })
  number!: string
  @ApiProperty({ example: '12/30' })
  @IsString()
  @Matches(/^(0[1-9]|1[0-2])\/\d{2}(?:\d{2})?$/, {
    message: 'El vencimiento debe tener el formato MM/AA o MM/AAAA.',
  })
  expiry!: string
  @ApiProperty({ example: '123' })
  @IsString()
  @Matches(/^\d{3,4}$/, {
    message: 'El codigo de seguridad debe tener 3 o 4 digitos.',
  })
  securityCode!: string
  @ApiProperty({ required: false, description: 'Version del resumen que acepto el cliente' })
  @IsOptional()
  @IsInt()
  @Min(0)
  expectedVersion?: number
}
export class PaymentResponse {
  @ApiProperty({ enum: ['COMPLETED', 'PROCESSING'] })
  readonly status!: 'COMPLETED' | 'PROCESSING'
  @ApiProperty({ type: OrderResponse })
  readonly order!: OrderResponse
  @ApiProperty({ example: 'sim-8f1c...' })
  readonly paymentReference!: string
  @ApiProperty({ description: 'Terminacion enmascarada; nunca contiene el numero completo' })
  readonly maskedCard!: string
  @ApiProperty({ example: false })
  readonly realMoneyMoved!: boolean
}
