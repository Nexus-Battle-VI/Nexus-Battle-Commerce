import { Order } from '../../domain/entities/Order'
import {
  CustomerId,
  Money,
  OrderId,
  Quantity,
  Sku,
} from '../../domain/value-objects/commerce-values'
import type { ClockPort } from '../ports/ClockPort'
import type { IdGeneratorPort } from '../ports/IdGeneratorPort'
import type { OrderRepositoryPort } from '../ports/OrderRepositoryPort'
import type { ProductPricingPort } from '../ports/ProductPricingPort'
import { OrderNotFoundError, ProductNotPurchasableError } from '../errors/ApplicationError'
import { type OrderDto, toOrderDto } from '../dto/OrderDto'

export interface OrderDependencies {
  readonly orders: OrderRepositoryPort
  readonly pricing: ProductPricingPort
  readonly clock: ClockPort
  readonly ids: IdGeneratorPort
}

export interface CreateOrderCommand {
  readonly customerId: string
  readonly currency: string
}

export interface AddLineCommand {
  readonly orderId: string
  readonly sku: string
  readonly quantity: number
}

const load = async (orders: OrderRepositoryPort, rawId: string): Promise<Order> => {
  const id = OrderId.create(rawId)
  const order = await orders.findById(id)

  if (order === null) {
    throw new OrderNotFoundError(id.value)
  }

  return order
}

/**
 * Abre un pedido vacio en borrador.
 */
export class CreateOrder {
  private readonly deps: OrderDependencies

  constructor(deps: OrderDependencies) {
    this.deps = deps
  }

  async execute(command: CreateOrderCommand): Promise<OrderDto> {
    // Se valida la moneda construyendo un importe cero antes de abrir el
    // pedido: abrirlo con una moneda invalida lo dejaria inutilizable.
    Money.zero(command.currency)

    const order = Order.draft({
      id: OrderId.create(this.deps.ids.generate()),
      customerId: CustomerId.create(command.customerId),
      currency: command.currency.trim().toUpperCase(),
    })

    await this.deps.orders.save(order)

    return toOrderDto(order.toSnapshot())
  }
}

/**
 * Anade unidades de un producto al pedido.
 *
 * El precio se consulta a Catalog **en este momento** y queda congelado dentro
 * de la linea. Un cambio posterior del catalogo no altera un pedido existente.
 */
export class AddOrderLine {
  private readonly deps: OrderDependencies

  constructor(deps: OrderDependencies) {
    this.deps = deps
  }

  async execute(command: AddLineCommand): Promise<OrderDto> {
    const order = await load(this.deps.orders, command.orderId)
    const sku = Sku.create(command.sku)
    const quantity = Quantity.create(command.quantity)

    const price = await this.deps.pricing.priceOf(sku.value)

    if (price === null) {
      throw new ProductNotPurchasableError(sku.value)
    }

    order.addLine(sku, Money.create(price.amount, price.currency), quantity)

    await this.deps.orders.save(order)

    return toOrderDto(order.toSnapshot())
  }
}

/**
 * Fija la cantidad de una linea a un valor exacto.
 *
 * No consulta el catalogo: el precio unitario ya esta congelado en la linea
 * desde que se anadio, y cambiar cuantas unidades se quieren no vuelve a
 * abrir esa negociacion.
 */
export class ChangeOrderLineQuantity {
  private readonly deps: OrderDependencies

  constructor(deps: OrderDependencies) {
    this.deps = deps
  }

  async execute(command: AddLineCommand): Promise<OrderDto> {
    const order = await load(this.deps.orders, command.orderId)

    order.changeLineQuantity(Sku.create(command.sku), Quantity.create(command.quantity))

    await this.deps.orders.save(order)

    return toOrderDto(order.toSnapshot())
  }
}

/**
 * Consulta el carrito vigente del cliente sin crearlo.
 *
 * Devuelve `null` cuando el cliente no tiene ningun borrador abierto. Es la
 * operacion que usa la interfaz para pintar el carrito en cada vista del
 * modulo, y por eso es una lectura pura: mostrar el carrito no puede tener el
 * efecto de crear uno.
 */
export class GetCart {
  private readonly orders: OrderRepositoryPort

  constructor(orders: OrderRepositoryPort) {
    this.orders = orders
  }

  async execute(rawCustomerId: string): Promise<OrderDto | null> {
    const found = await this.orders.findByCustomer(CustomerId.create(rawCustomerId))
    const draft = found.find((order) => order.isEditable)

    return draft === undefined ? null : toOrderDto(draft.toSnapshot())
  }
}

/**
 * Recupera el carrito vigente del cliente, y lo abre si todavia no existe.
 *
 * El carrito es el pedido en estado `DRAFT` del cliente: no hay una entidad
 * "carrito" aparte. Que la consulta lo cree cuando falta es lo que permite a
 * la interfaz mostrar un carrito vacio sin tener que decidir antes si debe
 * crearlo, y evita que dos peticiones simultaneas abran dos borradores.
 *
 * Si por cualquier razon existiera mas de un borrador, se toma el primero por
 * identificador y no se borra ninguno: descartar un pedido con lineas seria
 * peor que arrastrar un duplicado visible.
 */
export class GetOrCreateCart {
  private readonly deps: OrderDependencies

  constructor(deps: OrderDependencies) {
    this.deps = deps
  }

  async execute(rawCustomerId: string, currency: string): Promise<OrderDto> {
    const customerId = CustomerId.create(rawCustomerId)
    const existing = await this.deps.orders.findByCustomer(customerId)
    const draft = existing.find((order) => order.isEditable)

    if (draft !== undefined) {
      return toOrderDto(draft.toSnapshot())
    }

    Money.zero(currency)

    const order = Order.draft({
      id: OrderId.create(this.deps.ids.generate()),
      customerId,
      currency: currency.trim().toUpperCase(),
    })

    await this.deps.orders.save(order)

    return toOrderDto(order.toSnapshot())
  }
}

/**
 * Retira una referencia completa del pedido.
 */
export class RemoveOrderLine {
  private readonly deps: OrderDependencies

  constructor(deps: OrderDependencies) {
    this.deps = deps
  }

  async execute(orderId: string, rawSku: string): Promise<OrderDto> {
    const order = await load(this.deps.orders, orderId)

    order.removeLine(Sku.create(rawSku))

    await this.deps.orders.save(order)

    return toOrderDto(order.toSnapshot())
  }
}

/**
 * Confirma el pedido. A partir de aqui su contenido queda congelado.
 */
export class ConfirmOrder {
  private readonly deps: OrderDependencies

  constructor(deps: OrderDependencies) {
    this.deps = deps
  }

  async execute(orderId: string): Promise<OrderDto> {
    const order = await load(this.deps.orders, orderId)

    order.confirm(this.deps.clock.now())

    await this.deps.orders.save(order)
    order.pullEvents()

    return toOrderDto(order.toSnapshot())
  }
}

/**
 * Cancela el pedido.
 */
export class CancelOrder {
  private readonly deps: OrderDependencies

  constructor(deps: OrderDependencies) {
    this.deps = deps
  }

  async execute(orderId: string, reason: string): Promise<OrderDto> {
    const order = await load(this.deps.orders, orderId)

    order.cancel(reason, this.deps.clock.now())

    await this.deps.orders.save(order)
    order.pullEvents()

    return toOrderDto(order.toSnapshot())
  }
}

/**
 * Recupera un pedido por su identificador.
 */
export class GetOrder {
  private readonly orders: OrderRepositoryPort

  constructor(orders: OrderRepositoryPort) {
    this.orders = orders
  }

  async execute(orderId: string): Promise<OrderDto> {
    const order = await load(this.orders, orderId)

    return toOrderDto(order.toSnapshot())
  }
}

/**
 * Lista los pedidos de un cliente.
 */
export class ListCustomerOrders {
  private readonly orders: OrderRepositoryPort

  constructor(orders: OrderRepositoryPort) {
    this.orders = orders
  }

  async execute(customerId: string): Promise<readonly OrderDto[]> {
    const found = await this.orders.findByCustomer(CustomerId.create(customerId))

    return found.map((order) => toOrderDto(order.toSnapshot()))
  }
}
