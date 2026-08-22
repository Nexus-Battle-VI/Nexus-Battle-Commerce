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
  Post,
  Query,
  UnprocessableEntityException,
} from '@nestjs/common'
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger'

import { DomainError } from '../../../domain/errors/DomainError'
import {
  OrderNotFoundError,
  ProductNotPurchasableError,
} from '../../../application/errors/ApplicationError'
import type {
  AddOrderLine,
  CancelOrder,
  ConfirmOrder,
  CreateOrder,
  GetOrder,
  ListCustomerOrders,
  RemoveOrderLine,
} from '../../../application/use-cases/OrderUseCases'
import {
  ADD_LINE,
  CANCEL_ORDER,
  CONFIRM_ORDER,
  CREATE_ORDER,
  GET_ORDER,
  LIST_ORDERS,
  REMOVE_LINE,
} from './tokens'
import { AddLineRequest, CancelOrderRequest, CreateOrderRequest, OrderResponse } from './orders.dto'

/**
 * Adaptador de entrada HTTP.
 *
 * Traduce entre el protocolo y los casos de uso. No contiene reglas de negocio:
 * el calculo del total, el congelado del precio y la inmutabilidad del pedido
 * confirmado viven en el dominio.
 */
@ApiTags('orders')
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
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Abre un pedido en borrador' })
  @ApiResponse({ status: 201, description: 'Pedido creado', type: OrderResponse })
  @ApiResponse({ status: 400, description: 'Datos invalidos' })
  async create(@Body() body: CreateOrderRequest): Promise<OrderResponse> {
    try {
      return await this.createOrder.execute(body)
    } catch (error: unknown) {
      throw OrdersController.translate(error)
    }
  }

  @Get()
  @ApiOperation({ summary: 'Lista los pedidos de un cliente' })
  @ApiQuery({ name: 'customerId', required: true, example: 'acc-0b1d5b0e' })
  @ApiResponse({ status: 200, type: OrderResponse, isArray: true })
  @ApiResponse({ status: 400, description: 'Falta el identificador del cliente' })
  async list(@Query('customerId') customerId?: string): Promise<readonly OrderResponse[]> {
    try {
      return await this.listOrders.execute(customerId ?? '')
    } catch (error: unknown) {
      throw OrdersController.translate(error)
    }
  }

  @Get(':orderId')
  @ApiOperation({ summary: 'Recupera un pedido' })
  @ApiResponse({ status: 200, description: 'Pedido encontrado', type: OrderResponse })
  @ApiResponse({ status: 404, description: 'El pedido no existe' })
  async findOne(@Param('orderId') orderId: string): Promise<OrderResponse> {
    try {
      return await this.getOrder.execute(orderId)
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
  ): Promise<OrderResponse> {
    try {
      return await this.addLine.execute({ orderId, sku: body.sku, quantity: body.quantity })
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
  ): Promise<OrderResponse> {
    try {
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
  async confirm(@Param('orderId') orderId: string): Promise<OrderResponse> {
    try {
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
  ): Promise<OrderResponse> {
    try {
      return await this.cancelOrder.execute(orderId, body.reason)
    } catch (error: unknown) {
      throw OrdersController.translate(error)
    }
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
