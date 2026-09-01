/**
 * Puerto de la pasarela de pagos.
 *
 * **Ninguna implementacion de este puerto puede mover dinero real.** HU-59 es
 * explicita: el flujo es academico. El puerto existe para que esa prohibicion
 * sea estructural y no una nota en un comentario: Commerce no conoce ninguna
 * pasarela concreta, y la unica implementacion registrada es la simulada.
 *
 * Los datos de la tarjeta entran por aqui y **no salen**: no se persisten, no
 * se registran y no viajan en la respuesta. Lo unico que sobrevive a la
 * operacion es la referencia de la transaccion y los cuatro ultimos digitos,
 * que son lo que permite reconocer un cobro sin poder reproducirlo.
 */
export interface CardDetails {
  readonly holder: string
  readonly number: string
  readonly expiry: string
  readonly securityCode: string
}

export interface PaymentRequest {
  /**
   * Identificador de la operacion, que es el del pedido.
   *
   * Hace el cobro **idempotente**: reintentar la misma compra no cobra dos
   * veces. Sin el, un fallo de red despues de cobrar y antes de responder
   * dejaria a quien reintenta pagando dos veces la misma cosa.
   */
  readonly transactionId: string
  readonly amount: number
  readonly currency: string
  readonly card: CardDetails
}

export interface PaymentOutcome {
  readonly approved: boolean
  /** Referencia de la transaccion simulada. `null` cuando no se aprobo. */
  readonly reference: string | null
  /** Cuatro ultimos digitos. Nunca el numero completo. */
  readonly maskedCard: string
  /** Motivo del rechazo, apto para mostrar. `null` cuando se aprobo. */
  readonly declineReason: string | null
}

export interface PaymentGatewayPort {
  charge(request: PaymentRequest): Promise<PaymentOutcome>
}

export const PAYMENT_GATEWAY = Symbol('PaymentGatewayPort')
