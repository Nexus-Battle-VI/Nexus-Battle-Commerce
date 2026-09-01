import type { DomainEvent } from '../../domain/events/DomainEvent'

/**
 * Puerto de publicacion de eventos de dominio.
 *
 * Es la salida por la que HU-60 conecta con el modulo de correo: Commerce
 * publica «se confirmo esta compra, con este detalle y este total», y quien
 * envia el mensaje es Notifications. Commerce **no envia correos** y no conoce
 * plantillas, destinatarios ni proveedor de correo: si los conociera, el envio
 * seria responsabilidad suya y HU-60 dice expresamente que no lo es.
 *
 * El evento lleva el detalle completo para que el consumidor no tenga que
 * volver a preguntar por el pedido.
 */
export interface EventPublisherPort {
  publish(events: readonly DomainEvent[]): Promise<void>
}

export const EVENT_PUBLISHER = Symbol('EventPublisherPort')
