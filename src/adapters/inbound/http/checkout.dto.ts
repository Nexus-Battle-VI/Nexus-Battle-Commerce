import { ApiProperty } from '@nestjs/swagger'
import { IsInt, IsOptional, IsString, Matches, Min } from 'class-validator'
import { OrderResponse } from './orders.dto'

/** HU-59 exige cuatro datos presentes. No inventa reglas bancarias. */
export class PaymentRequestBody {
  @ApiProperty({ example: 'Ana Gomez' })
  @IsString()
  @Matches(/\S/, { message: 'El titular es obligatorio.' })
  holder!: string
  @ApiProperty({ example: '4111111111111111' })
  @IsString()
  @Matches(/\S/, { message: 'El numero de tarjeta es obligatorio.' })
  number!: string
  @ApiProperty({ example: '12/30' })
  @IsString()
  @Matches(/\S/, { message: 'El vencimiento es obligatorio.' })
  expiry!: string
  @ApiProperty({ example: '123' })
  @IsString()
  @Matches(/\S/, { message: 'El codigo de seguridad es obligatorio.' })
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
