import { DomainError } from '../../../domain/errors/DomainError'
import type {
  PaymentGatewayPort,
  PaymentOutcome,
  PaymentRequest,
} from '../../../application/ports/PaymentGatewayPort'

/**
 * Pasarela de pagos simulada.
 *
 * Es una implementacion **completa** del puerto, no un doble de pruebas: HU-59
 * pide una pasarela simulada, asi que esto es la funcionalidad pedida y no un
 * sustituto de algo que falte. No hay red, no hay proveedor y no hay forma de
 * que mueva dinero: el resultado se decide con una regla local.
 *
 * **La regla de decision es deliberadamente explicita y no aleatoria.** Un
 * resultado al azar haria que la misma compra se aprobara unas veces y otras
 * no, y con ello que las pruebas de aceptacion no fueran reproducibles.
 *
 * HU-59 dice que la historia «no establece marcas de tarjeta, longitudes
 * exactas, algoritmos de validacion ni bancos». Por eso aqui NO se valida
 * Luhn, ni marca, ni longitud: lo unico que se comprueba es que los cuatro
 * datos documentados vengan informados, que es lo que la historia si exige.
 *
 * Los numeros terminados en `0000` se rechazan. Es la unica convencion que se
 * anade, y existe para poder ejercitar el camino de rechazo (CP-59-02) sin
 * inventar reglas bancarias.
 */
export const DECLINED_SUFFIX = '0000'

export class SimulatedPaymentGateway implements PaymentGatewayPort {
  /**
   * Cobros **aprobados**, por `transactionId`.
   *
   * Solo se recuerdan los aprobados, y la distincion importa. Recordar tambien
   * los rechazos haria que un pedido al que se le rechazo una tarjeta quedara
   * rechazado para siempre: quien corrigiera el numero volveria a recibir el
   * rechazo antiguo y no podria pagar nunca. Un rechazo no cobro nada, asi que
   * no hay ningun cobro que proteger de la repeticion.
   *
   * Lo que si protege esta memoria es lo unico que lo necesita: que un
   * reintento tras un cobro aprobado no cobre una segunda vez.
   */
  private readonly approved = new Map<string, PaymentOutcome>()

  charge(request: PaymentRequest): Promise<PaymentOutcome> {
    if (
      [
        request.card.holder,
        request.card.number,
        request.card.expiry,
        request.card.securityCode,
      ].some((value) => value.trim() === '')
    )
      throw new DomainError('Los cuatro datos del pago son obligatorios.')
    const already = this.approved.get(request.transactionId)

    if (already !== undefined) {
      return Promise.resolve(already)
    }

    const digits = request.card.number.replace(/\D/g, '')
    const outcome = this.decide(request, digits)

    if (outcome.approved) {
      this.approved.set(request.transactionId, outcome)
    }

    return Promise.resolve(outcome)
  }

  private decide(request: PaymentRequest, digits: string): PaymentOutcome {
    const masked = digits.length > 4 ? digits.slice(-4) : '****'

    if (request.amount <= 0) {
      return {
        approved: false,
        reference: null,
        maskedCard: masked,
        declineReason: 'No se puede cobrar un importe que no es positivo.',
      }
    }

    if (digits.endsWith(DECLINED_SUFFIX)) {
      return {
        approved: false,
        reference: null,
        maskedCard: masked,
        declineReason: 'La pasarela simulada rechazo la tarjeta.',
      }
    }

    return {
      approved: true,
      // La referencia se deriva del pedido: la misma compra produce la misma
      // referencia, que es lo que permite reconocerla en un reintento.
      reference: `sim-${request.transactionId}`,
      maskedCard: masked,
      declineReason: null,
    }
  }
}
