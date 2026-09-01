import { OrderId } from '../../domain/value-objects/commerce-values'
import { DomainError } from '../../domain/errors/DomainError'
import { OrderNotFoundError } from '../errors/ApplicationError'
import type { OrderRepositoryPort } from '../ports/OrderRepositoryPort'
import type { ClockPort } from '../ports/ClockPort'
import type { CardDetails, PaymentGatewayPort } from '../ports/PaymentGatewayPort'
import type { PlayerInventoryPort } from '../ports/PlayerInventoryPort'
import { toOrderDto, type OrderDto } from '../dto/OrderDto'

export interface CheckoutDependencies {
  readonly orders: OrderRepositoryPort
  readonly payments: PaymentGatewayPort
  readonly inventory: PlayerInventoryPort
  readonly clock: ClockPort
}

export interface CheckoutCommand {
  readonly orderId: string
  readonly card: CardDetails
}

/** Resultado de una compra rechazada por la pasarela. */
export class PaymentDeclinedError extends Error {
  readonly maskedCard: string

  constructor(reason: string, maskedCard: string) {
    super(reason)
    this.name = 'PaymentDeclinedError'
    this.maskedCard = maskedCard
  }
}

export interface CheckoutResult {
  readonly order: OrderDto
  readonly paymentReference: string
  readonly maskedCard: string
}

/**
 * Resumen de la compra: el contenido vigente del carrito y su total.
 *
 * Se lee justo antes de pagar, y no se guarda en ningun sitio: CA-02 exige que
 * el resumen contenga «los productos actuales», asi que cualquier copia
 * anterior podria estar desfasada respecto al carrito.
 */
export class GetCheckoutSummary {
  private readonly orders: OrderRepositoryPort

  constructor(orders: OrderRepositoryPort) {
    this.orders = orders
  }

  async execute(rawOrderId: string): Promise<OrderDto> {
    const order = await this.orders.findById(OrderId.create(rawOrderId))

    if (order === null) {
      throw new OrderNotFoundError(rawOrderId)
    }

    return toOrderDto(order.toSnapshot())
  }
}

/**
 * Cierra la compra con la pasarela simulada.
 *
 * ## El orden de los tres pasos es la parte importante
 *
 * CA-02 exige que no haya «perdida, duplicacion ni transferencia parcial», ni
 * siquiera ante un fallo a mitad. Commerce y Player-Inventory son servicios
 * distintos, asi que **no existe una transaccion que los abarque a los dos**:
 * lo unico que se puede construir es una secuencia en la que cualquier
 * interrupcion deje un estado del que se pueda salir reintentando.
 *
 * El orden es:
 *
 * 1. **Cobrar.** Idempotente por el identificador del pedido.
 * 2. **Transferir al inventario.** Idempotente por el mismo identificador.
 * 3. **Confirmar el pedido y guardarlo.**
 *
 * Y estas son las unicas interrupciones posibles:
 *
 * - Si falla el paso 1, no cambia nada. El carrito sigue intacto.
 * - Si falla el paso 2, el pedido sigue en borrador y el carrito intacto.
 *   Reintentar no vuelve a cobrar, porque el paso 1 es idempotente.
 * - Si falla el paso 3, los productos ya estan en el inventario pero el pedido
 *   sigue en borrador. Reintentar no vuelve a cobrar ni vuelve a transferir, y
 *   termina confirmando. **No hay duplicacion.**
 *
 * Confirmar al final y no al principio es deliberado: si el pedido se
 * confirmara primero y luego fallara la transferencia, quedaria una compra
 * cerrada sin productos entregados, y `confirm` ya no admitiria reintento
 * porque un pedido confirmado no se puede volver a confirmar. Esa es
 * exactamente la transferencia parcial que CA-02 prohibe.
 */
export class CheckoutOrder {
  private readonly deps: CheckoutDependencies

  constructor(deps: CheckoutDependencies) {
    this.deps = deps
  }

  async execute(command: CheckoutCommand): Promise<CheckoutResult> {
    const orderId = OrderId.create(command.orderId)
    const order = await this.deps.orders.findById(orderId)

    if (order === null) {
      throw new OrderNotFoundError(command.orderId)
    }

    if (!order.isEditable) {
      throw new DomainError(`El pedido ${command.orderId} ya no admite el cierre de compra.`)
    }

    const snapshot = order.toSnapshot()

    if (snapshot.lines.length === 0) {
      throw new DomainError('No se puede pagar un carrito vacio.')
    }

    // 1. Cobro simulado. Ninguna implementacion de este puerto mueve dinero.
    const payment = await this.deps.payments.charge({
      transactionId: snapshot.id,
      amount: snapshot.totalAmount,
      currency: snapshot.currency,
      card: command.card,
    })

    if (!payment.approved || payment.reference === null) {
      // Nada se aplica: ni transferencia ni vaciado del carrito.
      throw new PaymentDeclinedError(
        payment.declineReason ?? 'La pasarela simulada no aprobo el pago.',
        payment.maskedCard,
      )
    }

    // 2. Transferencia al inventario, idempotente por el pedido.
    await this.deps.inventory.grant({
      transferId: snapshot.id,
      ownerId: snapshot.customerId,
      items: snapshot.lines.map((line) => ({ sku: line.sku, quantity: line.quantity })),
    })

    // 3. El pedido pasa a confirmado. Con ello deja de ser el carrito vigente,
    // que es como HU-59 queda «vacio»: no hace falta borrar nada, porque el
    // carrito es siempre el borrador y este ya no lo es.
    order.confirm(this.deps.clock.now())

    await this.deps.orders.save(order)

    return {
      order: toOrderDto(order.toSnapshot()),
      paymentReference: payment.reference,
      maskedCard: payment.maskedCard,
    }
  }
}
