/**
 * Contrato minimo de un evento de dominio. La marca de tiempo se recibe desde
 * el exterior: el dominio no lee el reloj del sistema.
 */
export interface DomainEvent {
  readonly name: string
  readonly aggregateId: string
  readonly occurredAt: Date
}
