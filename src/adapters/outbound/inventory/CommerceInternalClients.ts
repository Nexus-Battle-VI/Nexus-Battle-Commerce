import {
  IntegrationRejectedError,
  IntegrationUnavailableError,
  type CatalogReservationPort,
  type InventoryGrantPort,
  type PurchaseMailPort,
  type PurchaseNotification,
  type ReservationCommand,
} from '../../../application/ports/CommerceIntegrationPorts'
import { signInternalRequest } from '../identity/internal-signature'

export class InternalJsonClient {
  constructor(
    private readonly baseUrl: string,
    private readonly secret: string,
    private readonly timeoutMs: number,
    private readonly request: typeof fetch = fetch,
  ) {}

  async post(
    path: string,
    body: unknown,
    rejected: (status: number, payload: unknown) => boolean = () => false,
  ): Promise<unknown> {
    const timestamp = String(Date.now())
    try {
      const response = await this.request(`${this.baseUrl}${path}`, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: {
          'content-type': 'application/json',
          'x-internal-service': 'commerce',
          'x-internal-timestamp': timestamp,
          'x-internal-signature': signInternalRequest(this.secret, {
            service: 'commerce',
            method: 'POST',
            path,
            timestamp,
            body,
          }),
        },
        body: JSON.stringify(body),
      })
      const payload: unknown = await response.json()
      if (rejected(response.status, payload))
        throw new IntegrationRejectedError('El servicio rechazo la operacion sin aplicar el lote.')
      if (!response.ok)
        throw new IntegrationUnavailableError(
          `La operacion requiere recuperacion (${String(response.status)}).`,
        )
      return payload
    } catch (error: unknown) {
      if (error instanceof IntegrationRejectedError || error instanceof IntegrationUnavailableError)
        throw error
      throw new IntegrationUnavailableError(
        'No se pudo confirmar el resultado del servicio; se conserva la operacion para reintentar.',
      )
    }
  }
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object'

export class HttpCatalogReservations implements CatalogReservationPort {
  constructor(private readonly client: InternalJsonClient) {}
  async reserve(command: ReservationCommand): Promise<void> {
    const result = await this.client.post(
      '/api/internal/v1/catalog/reservations',
      command,
      (status, body) =>
        object(body) && body.code === 'RESERVATION_REJECTED' && (status === 404 || status === 409),
    )
    if (
      !object(result) ||
      result.reservationId !== command.reservationId ||
      !['RESERVED', 'CONFIRMED'].includes(String(result.state))
    )
      throw new IntegrationUnavailableError('Respuesta de reserva incompatible.')
  }
  async confirm(reservationId: string, playerId: string): Promise<void> {
    const result = await this.client.post(
      `/api/internal/v1/catalog/reservations/${encodeURIComponent(reservationId)}/confirmation`,
      { playerId },
    )
    if (!object(result) || result.reservationId !== reservationId || result.state !== 'CONFIRMED')
      throw new IntegrationUnavailableError('No se confirmo la reserva.')
  }
  async release(reservationId: string, playerId: string): Promise<void> {
    const result = await this.client.post(
      `/api/internal/v1/catalog/reservations/${encodeURIComponent(reservationId)}/release`,
      { playerId },
    )
    if (!object(result) || result.reservationId !== reservationId || result.state !== 'RELEASED')
      throw new IntegrationUnavailableError('No se confirmo la liberacion.')
  }
}

export class HttpInventoryGrant implements InventoryGrantPort {
  constructor(private readonly client: InternalJsonClient) {}
  async grant(command: Parameters<InventoryGrantPort['grant']>[0]): Promise<void> {
    const result = await this.client.post(
      '/api/internal/v1/inventory/grants',
      command,
      (status, data) => status === 422 && object(data) && data.code === 'INVENTORY_REJECTED',
    )
    if (!object(result) || result.operationId !== command.operationId || result.applied !== true)
      throw new IntegrationUnavailableError('No se confirmo la entrega al inventario.')
  }
}

export class HttpPurchaseMail implements PurchaseMailPort {
  constructor(private readonly client: InternalJsonClient) {}
  async send(command: PurchaseNotification): Promise<void> {
    const result = await this.client.post('/api/internal/v1/notifications/purchases', command)
    if (
      !object(result) ||
      result.notificationId !== command.notificationId ||
      result.status !== 'SENT'
    )
      throw new IntegrationUnavailableError('El correo sigue pendiente de confirmacion.')
  }
}
