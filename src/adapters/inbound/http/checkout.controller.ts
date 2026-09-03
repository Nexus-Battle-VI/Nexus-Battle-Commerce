import { translateIntegrationError } from './integration-errors'
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common'
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger'

import { DomainError } from '../../../domain/errors/DomainError'
import { OrderNotFoundError } from '../../../application/errors/ApplicationError'
import {
  CatalogUnavailableError,
  ProductNotInCatalogError,
  ProductSoldOutError,
} from '../../../application/ports/CatalogInventoryPort'
import {
  PaymentDeclinedError,
  type CheckoutCommand,
  type CheckoutResult,
  type GetCheckoutSummary,
} from '../../../application/use-cases/CheckoutUseCases'
import type { PurchaseStatus } from '../../../application/ports/CommerceIntegrationPorts'
import type { GetOrder } from '../../../application/use-cases/OrderUseCases'
import { CHECKOUT_ORDER, CHECKOUT_SUMMARY } from './tokens.checkout'
import { GET_ORDER } from './tokens'
import { PaymentRequestBody, PaymentResponse } from './checkout.dto'
import { OrderResponse } from './orders.dto'
import { CurrentIdentity } from './auth/decorators'
import type { VerifiedIdentity } from '../../../application/ports/TokenVerifierPort'

/**
 * Cierre de compra con pasarela simulada (HU-59).
 *
 * **Ninguna ruta de este controlador mueve dinero real**, y la respuesta lo
 * declara de forma explicita con `realMoneyMoved: false`. CA-03 exige que la
 * evidencia confirme la ausencia de movimiento financiero; que el propio
 * contrato lo diga hace esa evidencia observable en cada respuesta en lugar de
 * depender de una nota externa.
 *
 * Los datos de la tarjeta entran en el cuerpo y no salen de la peticion: no se
 * persisten, no se registran y solo vuelven como los cuatro ultimos digitos.
 */
@ApiTags('checkout')
@ApiBearerAuth()
@Controller('orders/:orderId')
export class CheckoutController {
  constructor(
    @Inject(CHECKOUT_SUMMARY) private readonly summary: GetCheckoutSummary,
    @Inject(CHECKOUT_ORDER)
    private readonly checkout: {
      execute(command: CheckoutCommand): Promise<CheckoutResult>
      status?(orderId: string): Promise<PurchaseStatus>
    },
    @Inject(GET_ORDER) private readonly getOrder: GetOrder,
  ) {}

  @Get('checkout')
  @ApiOperation({ summary: 'Resumen de la compra: productos vigentes y total a pagar' })
  @ApiResponse({ status: 200, description: 'Resumen de la compra', type: OrderResponse })
  @ApiResponse({ status: 404, description: 'El pedido no existe' })
  async checkoutSummary(
    @Param('orderId') orderId: string,
    @CurrentIdentity() identity: VerifiedIdentity,
  ): Promise<OrderResponse> {
    try {
      await this.assertOwned(orderId, identity)

      return await this.summary.execute(orderId)
    } catch (error: unknown) {
      throw CheckoutController.translate(error)
    }
  }

  @Get('payment')
  @ApiOperation({ summary: 'Consulta un intento de compra sin volver a pagar' })
  @ApiResponse({ status: 200, type: PaymentResponse })
  async paymentStatus(
    @Param('orderId') orderId: string,
    @CurrentIdentity() identity: VerifiedIdentity,
  ): Promise<PaymentResponse> {
    try {
      await this.assertOwned(orderId, identity)
      if (this.checkout.status === undefined)
        throw new NotFoundException('No hay un intento de compra registrado.')
      return { ...(await this.checkout.status(orderId)), realMoneyMoved: false }
    } catch (error: unknown) {
      throw CheckoutController.translate(error)
    }
  }

  @Post('payment')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Confirma el pago simulado y cierra la compra' })
  @ApiResponse({ status: 200, description: 'Compra completada', type: PaymentResponse })
  @ApiResponse({ status: 400, description: 'Faltan datos del formulario o el carrito esta vacio' })
  @ApiResponse({ status: 402, description: 'La pasarela simulada rechazo el pago' })
  @ApiResponse({ status: 404, description: 'El pedido no existe' })
  async pay(
    @Param('orderId') orderId: string,
    @Body() body: PaymentRequestBody,
    @Headers('authorization') authorization: string | undefined,
    @CurrentIdentity() identity: VerifiedIdentity,
  ): Promise<PaymentResponse> {
    try {
      await this.assertOwned(orderId, identity)

      const result = await this.checkout.execute({
        orderId,
        ...(body.expectedVersion === undefined ? {} : { expectedVersion: body.expectedVersion }),
        accessToken: authorization?.replace(/^Bearer\s+/i, '') ?? '',
        card: {
          holder: body.holder,
          number: body.number,
          expiry: body.expiry,
          securityCode: body.securityCode,
        },
      })

      return {
        status: result.status ?? 'COMPLETED',
        order: result.order,
        paymentReference: result.paymentReference,
        maskedCard: result.maskedCard,
        realMoneyMoved: false,
      }
    } catch (error: unknown) {
      throw CheckoutController.translate(error)
    }
  }

  /**
   * Nadie paga el pedido de otra persona.
   *
   * Responde `404` y no `403` cuando el pedido es de otro: confirmar que
   * existe ya seria decir mas de lo debido.
   */
  private async assertOwned(orderId: string, identity: VerifiedIdentity): Promise<void> {
    const order = await this.getOrder.execute(orderId)

    if (order.customerId !== identity.subject) {
      throw new NotFoundException(`No existe el pedido ${orderId}.`)
    }
  }

  private static translate(error: unknown): Error {
    const integrationError = translateIntegrationError(error)
    if (integrationError !== null) return integrationError

    if (error instanceof OrderNotFoundError) {
      return new NotFoundException(error.message)
    }

    if (error instanceof PaymentDeclinedError) {
      // 402 Payment Required: la peticion es correcta y el pedido tambien; lo
      // que falla es el cobro. Un 400 diria que el cliente se equivoco al
      // formar la peticion, que no es el caso.
      return new HttpException(error.message, HttpStatus.PAYMENT_REQUIRED)
    }

    // HU-34. Los tres significan cosas distintas y se responden distinto: un
    // texto unico mandaria al comprador a resolver algo que no depende de el.
    if (error instanceof ProductSoldOutError) {
      // 409: la peticion es correcta y lo que falla es el estado del producto.
      // Habria funcionado un minuto antes y volvera a funcionar si el
      // administrador amplia el tiraje.
      return new ConflictException(error.message)
    }

    if (error instanceof ProductNotInCatalogError) {
      return new NotFoundException(error.message)
    }

    if (error instanceof CatalogUnavailableError) {
      // 503, NO 409. No se pudo preguntar, que no es lo mismo que no haber
      // unidades: decirle «agotado» a alguien porque Catalog no responde es
      // afirmar algo falso.
      return new HttpException(error.message, HttpStatus.SERVICE_UNAVAILABLE)
    }

    if (error instanceof DomainError) {
      return new BadRequestException(error.message)
    }

    if (error instanceof NotFoundException || error instanceof ForbiddenException) {
      return error
    }

    return error instanceof Error ? error : new Error(String(error))
  }
}
