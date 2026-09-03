import {
  Order,
  type OrderLineSnapshot,
  type ProductPresentation,
} from '../../domain/entities/Order'
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
import type { ProductPrice, ProductPricingPort } from '../ports/ProductPricingPort'
import { CheckoutConflictError } from '../ports/CommerceIntegrationPorts'
import { DomainError } from '../../domain/errors/DomainError'
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
  readonly productId?: string
  readonly sku?: string
  readonly quantity: number
}

const load = async (orders: OrderRepositoryPort, rawId: string): Promise<Order> => {
  const id = OrderId.create(rawId)
  const order = await orders.findById(id)
  if (order === null) throw new OrderNotFoundError(id.value)
  return order
}
const editable = (order: Order): void => {
  if (!order.isEditable)
    throw new CheckoutConflictError(
      'El pedido no admite cambios: la compra esta en proceso o ya termino.',
    )
}
/** PROCESSING sigue siendo el carrito vigente; no se abre otro mientras se resuelve. */
export const currentCart = (orders: readonly Order[]): Order | undefined =>
  orders.find((order) => order.currentStatus === 'PROCESSING') ??
  orders.find((order) => order.isEditable)

export const isUniqueConflict = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === '23505'

export const requirePrice = async (
  pricing: ProductPricingPort,
  reference: string,
): Promise<ProductPrice> => {
  const price = await pricing.priceOf(reference)
  if (price === null) throw new ProductNotPurchasableError(reference)
  return price
}
/** La cantidad total se contrasta con stock; un cambio de precio exige una nueva aceptacion. */
export const checkCartQuote = (
  price: ProductPrice,
  quantity: number,
  currency: string,
  agreedAmount?: number,
): void => {
  Quantity.create(quantity)
  const money = Money.create(price.amount, price.currency)
  if (money.currency !== Money.zero(currency).currency)
    throw new CheckoutConflictError('La moneda del producto no coincide con la del carrito.')
  if (agreedAmount !== undefined && agreedAmount !== money.amount)
    throw new CheckoutConflictError(
      'El precio del producto cambio. Retiralo y agregalo de nuevo para aceptar el precio vigente.',
    )
  if (
    price.availableUnits !== undefined &&
    price.availableUnits !== null &&
    quantity > price.availableUnits
  )
    throw new CheckoutConflictError('La cantidad solicitada supera la disponibilidad del producto.')
}

export const productPresentation = (price: ProductPrice): ProductPresentation => ({
  ...(price.productId === undefined ? {} : { productId: price.productId, catalogSku: price.sku }),
  ...(price.name === undefined ? {} : { name: price.name }),
  ...(price.imageUrl === undefined ? {} : { imageUrl: price.imageUrl }),
})
const matches = (line: OrderLineSnapshot, references: readonly string[]): boolean =>
  [line.sku, line.productId, line.catalogSku].some(
    (value) => value !== undefined && references.includes(value.toLowerCase()),
  )

const matchingLines = (order: Order, price: ProductPrice): readonly OrderLineSnapshot[] =>
  order
    .toSnapshot()
    .lines.filter((line) =>
      matches(line, [
        price.sku.toLowerCase(),
        ...(price.productId === undefined ? [] : [price.productId.toLowerCase()]),
      ]),
    )

/** Migra una linea legacy en memoria; se persiste junto con la unica mutacion final. */
const canonicalize = (order: Order, price: ProductPrice): Order => {
  const productId = price.productId
  if (productId === undefined) return order
  const existing = matchingLines(order, price)
  const first = existing[0]
  if (first === undefined) return order
  const snapshot = order.toSnapshot()
  const retained = snapshot.lines.filter(
    (line) => !matches(line, [price.sku.toLowerCase(), productId.toLowerCase()]),
  )
  return Order.restore({
    id: order.id,
    customerId: order.customerId,
    currency: order.currency,
    status: order.currentStatus,
    version: order.persistenceVersion,
    lines: [
      ...retained.map((line) => ({
        ...line,
        sku: Sku.create(line.sku),
        unitPrice: Money.create(line.unitPriceAmount, order.currency),
        quantity: Quantity.create(line.quantity),
      })),
      {
        sku: Sku.create(productId),
        unitPrice: Money.create(first.unitPriceAmount, order.currency),
        quantity: Quantity.create(existing.reduce((sum, line) => sum + line.quantity, 0)),
        ...productPresentation(price),
      },
    ],
  })
}
const lineReference = async (
  order: Order,
  raw: string,
  pricing: ProductPricingPort,
): Promise<Sku> => {
  const reference = Sku.create(raw).value
  const direct = order.toSnapshot().lines.find((line) => matches(line, [reference]))
  if (direct !== undefined) return Sku.create(direct.sku)
  const product = await pricing.productOf?.(reference)
  const resolved =
    product === undefined || product === null
      ? undefined
      : order
          .toSnapshot()
          .lines.find((line) =>
            matches(line, [product.productId.toLowerCase(), product.sku.toLowerCase()]),
          )
  return Sku.create(resolved?.sku ?? reference)
}

export class CreateOrder {
  constructor(private readonly deps: OrderDependencies) {}
  execute(command: CreateOrderCommand): Promise<OrderDto> {
    return new GetOrCreateCart(this.deps).execute(command.customerId, command.currency)
  }
}

export class AddOrderLine {
  constructor(private readonly deps: OrderDependencies) {}
  async execute(command: AddLineCommand): Promise<OrderDto> {
    let order = await load(this.deps.orders, command.orderId)
    editable(order)
    const reference = Sku.create(command.productId ?? command.sku ?? '').value
    const quantity = Quantity.create(command.quantity)
    const price = await requirePrice(this.deps.pricing, reference)
    const existing = matchingLines(order, price)
    const total = quantity.value + existing.reduce((sum, line) => sum + line.quantity, 0)
    checkCartQuote(price, total, order.currency)
    for (const line of existing) checkCartQuote(price, total, order.currency, line.unitPriceAmount)
    order = canonicalize(order, price)
    order.addLine(
      Sku.create(price.productId ?? price.sku),
      Money.create(price.amount, price.currency),
      quantity,
      productPresentation(price),
    )
    await this.deps.orders.save(order)
    return toOrderDto(order.toSnapshot())
  }
}

export class ChangeOrderLineQuantity {
  constructor(private readonly deps: OrderDependencies) {}
  async execute(command: AddLineCommand): Promise<OrderDto> {
    let order = await load(this.deps.orders, command.orderId)
    editable(order)
    const reference = await lineReference(
      order,
      command.productId ?? command.sku ?? '',
      this.deps.pricing,
    )
    const line = order.toSnapshot().lines.find((candidate) => candidate.sku === reference.value)
    if (line === undefined) throw new DomainError('La linea no existe.')
    const price = await requirePrice(this.deps.pricing, line.productId ?? line.sku)
    for (const match of matchingLines(order, price))
      checkCartQuote(price, command.quantity, order.currency, match.unitPriceAmount)
    checkCartQuote(price, command.quantity, order.currency, line.unitPriceAmount)
    order = canonicalize(order, price)
    order.changeLineQuantity(
      Sku.create(price.productId ?? line.sku),
      Quantity.create(command.quantity),
    )
    await this.deps.orders.save(order)
    return toOrderDto(order.toSnapshot())
  }
}

export class GetCart {
  constructor(private readonly orders: OrderRepositoryPort) {}
  async execute(rawCustomerId: string): Promise<OrderDto | null> {
    const cart = currentCart(await this.orders.findByCustomer(CustomerId.create(rawCustomerId)))
    return cart === undefined ? null : toOrderDto(cart.toSnapshot())
  }
}

export class GetOrCreateCart {
  constructor(private readonly deps: OrderDependencies) {}
  private async existing(order: Order, currency: string): Promise<OrderDto> {
    if (order.currency !== currency) {
      editable(order)
      if (!order.isEmpty)
        throw new CheckoutConflictError('Vacia el carrito antes de cambiar su moneda.')
      order.changeCurrency(currency)
      await this.deps.orders.save(order)
    }
    return toOrderDto(order.toSnapshot())
  }
  async execute(rawCustomerId: string, rawCurrency: string): Promise<OrderDto> {
    const customerId = CustomerId.create(rawCustomerId)
    const currency = Money.zero(rawCurrency).currency
    const existing = currentCart(await this.deps.orders.findByCustomer(customerId))
    if (existing !== undefined) return this.existing(existing, currency)
    const order = Order.draft({
      id: OrderId.create(this.deps.ids.generate()),
      customerId,
      currency,
    })
    try {
      await this.deps.orders.save(order)
    } catch (error: unknown) {
      if (!isUniqueConflict(error)) throw error
      const winner = currentCart(await this.deps.orders.findByCustomer(customerId))
      if (winner === undefined) throw error
      return this.existing(winner, currency)
    }
    return toOrderDto(order.toSnapshot())
  }
}

export class RemoveOrderLine {
  constructor(private readonly deps: OrderDependencies) {}
  async execute(orderId: string, rawReference: string): Promise<OrderDto> {
    const order = await load(this.deps.orders, orderId)
    editable(order)
    const reference = await lineReference(order, rawReference, this.deps.pricing)
    const line = order.toSnapshot().lines.find((candidate) => candidate.sku === reference.value)
    if (line === undefined) throw new DomainError('La linea no existe.')
    const aliases = [line.sku, line.productId, line.catalogSku]
      .filter((value): value is string => value !== undefined)
      .map((value) => value.toLowerCase())
    for (const candidate of order.toSnapshot().lines.filter((item) => matches(item, aliases)))
      order.removeLine(Sku.create(candidate.sku))
    await this.deps.orders.save(order)
    return toOrderDto(order.toSnapshot())
  }
}

/** Las rutas historicas no pueden saltarse pago, reserva y entrega. */
export class ConfirmOrder {
  constructor(private readonly deps: OrderDependencies) {}
  async execute(orderId: string): Promise<OrderDto> {
    await load(this.deps.orders, orderId)
    throw new CheckoutConflictError(
      'La orden solo se confirma mediante una compra simulada completada.',
    )
  }
}

export class CancelOrder {
  constructor(private readonly deps: OrderDependencies) {}
  async execute(orderId: string, reason: string): Promise<OrderDto> {
    const order = await load(this.deps.orders, orderId)
    editable(order)
    order.cancel(reason, this.deps.clock.now())
    await this.deps.orders.save(order)
    order.pullEvents()
    return toOrderDto(order.toSnapshot())
  }
}
export class GetOrder {
  constructor(private readonly orders: OrderRepositoryPort) {}
  async execute(orderId: string): Promise<OrderDto> {
    return toOrderDto((await load(this.orders, orderId)).toSnapshot())
  }
}
export class ListCustomerOrders {
  constructor(private readonly orders: OrderRepositoryPort) {}
  async execute(customerId: string): Promise<readonly OrderDto[]> {
    return (await this.orders.findByCustomer(CustomerId.create(customerId))).map((order) =>
      toOrderDto(order.toSnapshot()),
    )
  }
}
