import type { EventPublisherPort } from '../../../application/ports/EventPublisherPort'
import type { DomainEvent } from '../../../domain/events/DomainEvent'
import type { Logger } from '../../../infrastructure/observability/logger'

/**
 * Publicador de eventos dentro del proceso.
 *
 * Implementacion completa del puerto, no un doble de pruebas. Registra cada
 * evento publicado y lo conserva, de modo que la publicacion sea observable
 * sin necesidad de un broker.
 *
 * **Limitacion conocida, y deliberada:** los eventos se publican DESPUES de
 * que el pedido este guardado. Con un publicador en proceso eso no puede
 * fallar, pero con un broker real si podria, y entonces una compra completada
 * se quedaria sin su correo de confirmacion. Resolverlo exige un patron
 * outbox —escribir el evento en la misma transaccion que el pedido y
 * entregarlo aparte—, y esa decision no es de esta historia: esta abierta como
 * `EN-027.2` en Management. Introducir un broker antes de tomarla dejaria un
 * agujero silencioso.
 */
export class InMemoryEventPublisher implements EventPublisherPort {
  private readonly logger: Logger | null
  private readonly log: DomainEvent[] = []

  constructor(logger: Logger | null = null) {
    this.logger = logger
  }

  publish(events: readonly DomainEvent[]): Promise<void> {
    for (const event of events) {
      this.log.push(event)

      this.logger?.info('domain_event_published', {
        event: event.name,
        aggregateId: event.aggregateId,
      })
    }

    return Promise.resolve()
  }

  /** Eventos publicados, en orden. */
  get published(): readonly DomainEvent[] {
    return [...this.log]
  }

  publishedOf(name: string): readonly DomainEvent[] {
    return this.log.filter((event) => event.name === name)
  }
}
