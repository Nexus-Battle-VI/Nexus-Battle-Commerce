import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  UnprocessableEntityException,
} from '@nestjs/common'
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger'

import { DomainError } from '../../../domain/errors/DomainError'
import {
  OrderNotFoundError,
  ProductNotPurchasableError,
} from '../../../application/errors/ApplicationError'
import type {
  AddOrderLine,
  CancelOrder,
  ChangeOrderLineQuantity,
  ConfirmOrder,
  CreateOrder,
  GetCart,
  GetOrCreateCart,
  GetOrder,
  ListCustomerOrders,
  RemoveOrderLine,
} from '../../../application/use-cases/OrderUseCases'
import {
  ADD_LINE,
  CANCEL_ORDER,
  CHANGE_LINE_QUANTITY,
  CONFIRM_ORDER,
  CREATE_ORDER,
  GET_CART,
  GET_OR_CREATE_CART,
  GET_ORDER,
  LIST_ORDERS,
  REMOVE_LINE,
} from './tokens'
import {
  AddLineRequest,
  CancelOrderRequest,
  ChangeLineQuantityRequest,
  CreateOrderRequest,
  OpenCartRequest,
  OrderResponse,
} from './orders.dto'

import { Role, type VerifiedIdentity } from '../../../application/ports/TokenVerifierPort'
import { CurrentIdentity } from './auth/decorators'

/**
 * Adaptador de entrada HTTP.
 *
 * Traduce entre el protocolo y los casos de uso. No contiene reglas de negocio:
 * el calculo del total, el congelado del precio y la inmutabilidad del pedido
 * confirmado viven en el dominio.
 */
@ApiTags('orders')
@ApiBearerAuth()
@Controller('orders')
export class OrdersController {
  constructor(
    @Inject(CREATE_ORDER) private readonly createOrder: CreateOrder,
    @Inject(ADD_LINE) private readonly addLine: AddOrderLine,
    @Inject(REMOVE_LINE) private readonly removeLine: RemoveOrderLine,
    @Inject(CONFIRM_ORDER) private readonly confirmOrder: ConfirmOrder,
    @Inject(CANCEL_ORDER) private readonly cancelOrder: CancelOrder,
    @Inject(GET_ORDER) private readonly getOrder: GetOrder,
    @Inject(LIST_ORDERS) private readonly listOrders: ListCustomerOrders,
    @Inject(CHANGE_LINE_QUANTITY) private readonly changeLineQuantity: ChangeOrderLineQuantity,
    @Inject(GET_CART) private readonly getCart: GetCart,
    @Inject(GET_OR_CREATE_CART) private readonly getOrCreateCart: GetOrCreateCart,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Abre un pedido en borrador' })
  @ApiResponse({ status: 201, description: 'Pedido creado', type: OrderResponse })
  @ApiResponse({ status: 400, description: 'Datos invalidos' })
  async create(
    @Body() body: CreateOrderRequest,
    @CurrentIdentity() identity: VerifiedIdentity,
  ): Promise<OrderResponse> {
    try {
      // El cliente NO se lee del cuerpo: sale del testimonio verificado.
      return await this.createOrder.execute({
        customerId: identity.subject,
        currency: body.currency,
      })
    } catch (error: unknown) {
      throw OrdersController.translate(error)
    }
  }

  @Get()
  @ApiOperation({ summary: 'Lista los pedidos de un cliente' })
  @ApiResponse({ status: 200, type: OrderResponse, isArray: true })
  async list(@CurrentIdentity() identity: VerifiedIdentity): Promise<readonly OrderResponse[]> {
    try {
      // Ya no hay parametro `customerId`. Listar los pedidos de otra persona
      // era cuestion de cambiar un valor en la cadena de consulta.
      return await this.listOrders.execute(identity.subject)
    } catch (error: unknown) {
      throw OrdersController.translate(error)
    }
  }

  /**
   * El carrito vigente del cliente.
   *
   * Se declara ANTES de `:orderId`: NestJS resuelve las rutas en el orden en
   * que se registran, y con el orden inverso `cart` se interpretaria como el
   * identificador de un pedido y esta ruta no se alcanzaria nunca.
   */
  @Get('cart')
  @ApiOperation({ summary: 'Recupera el carrito vigente de quien realiza la peticion' })
  @ApiResponse({ status: 200, description: 'Carrito vigente', type: OrderResponse })
  @ApiResponse({ status: 404, description: 'El cliente no tiene ningun carrito abierto' })
  async cart(@CurrentIdentity() identity: VerifiedIdentity): Promise<OrderResponse> {
    const found = await this.getCart.execute(identity.subject)

    if (found === null) {
      // 404 y no un carrito vacio inventado: un carrito que no existe y uno
      // vacio son estados distintos, y la interfaz necesita distinguirlos.
      throw new NotFoundException('No hay un carrito abierto para este cliente.')
    }

    return found
  }

  @Post('cart')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Abre el carrito del cliente, o devuelve el que ya tenia' })
  @ApiResponse({ status: 200, description: 'Carrito vigente', type: OrderResponse })
  @ApiResponse({ status: 400, description: 'Moneda no soportada' })
  async openCart(
    @Body() body: OpenCartRequest,
    @CurrentIdentity() identity: VerifiedIdentity,
  ): Promise<OrderResponse> {
    try {
      // Idempotente: llamarlo dos veces no abre dos carritos.
      return await this.getOrCreateCart.execute(identity.subject, body.currency)
    } catch (error: unknown) {
      throw OrdersController.translate(error)
    }
  }

  @Get(':orderId')
  @ApiOperation({ summary: 'Recupera un pedido' })
  @ApiResponse({ status: 200, description: 'Pedido encontrado', type: OrderResponse })
  @ApiResponse({ status: 404, description: 'El pedido no existe' })
  async findOne(
    @Param('orderId') orderId: string,
    @CurrentIdentity() identity: VerifiedIdentity,
  ): Promise<OrderResponse> {
    try {
      return await this.assertOwned(orderId, identity)
    } catch (error: unknown) {
      throw OrdersController.translate(error)
    }
  }

  @Post(':orderId/lines')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Anade unidades de un producto al pedido' })
  @ApiResponse({ status: 200, description: 'Pedido actualizado', type: OrderResponse })
  @ApiResponse({ status: 400, description: 'Datos invalidos o pedido no editable' })
  @ApiResponse({ status: 404, description: 'El pedido no existe' })
  @ApiResponse({ status: 422, description: 'El producto no existe o no esta a la venta' })
  async add(
    @Param('orderId') orderId: string,
    @Body() body: AddLineRequest,
    @CurrentIdentity() identity: VerifiedIdentity,
  ): Promise<OrderResponse> {
    try {
      await this.assertOwned(orderId, identity)

      return await this.addLine.execute({ orderId, sku: body.sku, quantity: body.quantity })
    } catch (error: unknown) {
      throw OrdersController.translate(error)
    }
  }

  @Patch(':orderId/lines/:sku')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Fija la cantidad de una referencia del pedido' })
  @ApiResponse({ status: 200, description: 'Pedido actualizado', type: OrderResponse })
  @ApiResponse({ status: 400, description: 'La referencia no esta en el pedido o no es editable' })
  @ApiResponse({ status: 404, description: 'El pedido no existe' })
  async changeQuantity(
    @Param('orderId') orderId: string,
    @Param('sku') sku: string,
    @Body() body: ChangeLineQuantityRequest,
    @CurrentIdentity() identity: VerifiedIdentity,
  ): Promise<OrderResponse> {
    try {
      await this.assertOwned(orderId, identity)

      return await this.changeLineQuantity.execute({ orderId, sku, quantity: body.quantity })
    } catch (error: unknown) {
      throw OrdersController.translate(error)
    }
  }

  @Delete(':orderId/lines/:sku')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Retira una referencia del pedido' })
  @ApiResponse({ status: 200, description: 'Pedido actualizado', type: OrderResponse })
  @ApiResponse({ status: 400, description: 'La referencia no esta en el pedido o no es editable' })
  @ApiResponse({ status: 404, description: 'El pedido no existe' })
  async remove(
    @Param('orderId') orderId: string,
    @Param('sku') sku: string,
    @CurrentIdentity() identity: VerifiedIdentity,
  ): Promise<OrderResponse> {
    try {
      await this.assertOwned(orderId, identity)

      return await this.removeLine.execute(orderId, sku)
    } catch (error: unknown) {
      throw OrdersController.translate(error)
    }
  }

  @Post(':orderId/confirmation')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Confirma el pedido' })
  @ApiResponse({ status: 200, description: 'Pedido confirmado', type: OrderResponse })
  @ApiResponse({ status: 400, description: 'El pedido esta vacio o ya no es editable' })
  @ApiResponse({ status: 404, description: 'El pedido no existe' })
  async confirm(
    @Param('orderId') orderId: string,
    @CurrentIdentity() identity: VerifiedIdentity,
  ): Promise<OrderResponse> {
    try {
      await this.assertOwned(orderId, identity)

      return await this.confirmOrder.execute(orderId)
    } catch (error: unknown) {
      throw OrdersController.translate(error)
    }
  }

  @Post(':orderId/cancellation')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancela el pedido' })
  @ApiResponse({ status: 200, description: 'Pedido cancelado', type: OrderResponse })
  @ApiResponse({ status: 400, description: 'El pedido ya estaba cancelado' })
  @ApiResponse({ status: 404, description: 'El pedido no existe' })
  async cancel(
    @Param('orderId') orderId: string,
    @Body() body: CancelOrderRequest,
    @CurrentIdentity() identity: VerifiedIdentity,
  ): Promise<OrderResponse> {
    try {
      await this.assertOwned(orderId, identity)

      return await this.cancelOrder.execute(orderId, body.reason)
    } catch (error: unknown) {
      throw OrdersController.translate(error)
    }
  }

  /**
   * Comprueba que el pedido pertenece a quien lo pide y lo devuelve.
   *
   * Un pedido ajeno responde 404 y NO 403. Distinguirlos confirmaria que el
   * pedido existe, y con eso se pueden enumerar pedidos de otras personas
   * probando identificadores. Un administrador queda exento.
   */
  private async assertOwned(orderId: string, identity: VerifiedIdentity): Promise<OrderResponse> {
    const order = await this.getOrder.execute(orderId)

    if (order.customerId !== identity.subject && !identity.roles.has(Role.Administrator)) {
      throw new OrderNotFoundError(orderId)
    }

    return order
  }

  /**
   * Un producto inexistente en el catalogo se traduce a 422 y no a 404: el
   * recurso de la peticion (el pedido) si existe; lo que no se puede procesar
   * es el contenido.
   */
  private static translate(error: unknown): Error {
    if (error instanceof OrderNotFoundError) {
      return new NotFoundException(error.message)
    }

    if (error instanceof ProductNotPurchasableError) {
      return new UnprocessableEntityException(error.message)
    }

    if (error instanceof DomainError) {
      return new BadRequestException(error.message)
    }

    return error instanceof Error ? error : new Error('Fallo desconocido del servicio.')
  }
}
