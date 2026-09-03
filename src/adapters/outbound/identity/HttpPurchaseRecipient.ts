import {
  IntegrationUnavailableError,
  type PurchaseRecipientPort,
} from '../../../application/ports/CommerceIntegrationPorts'

export class HttpPurchaseRecipient implements PurchaseRecipientPort {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number,
    private readonly request: typeof fetch = fetch,
  ) {}

  async resolve(_subject: string, accessToken: string): Promise<string> {
    if (accessToken.length === 0)
      throw new IntegrationUnavailableError(
        'Se requiere una sesion para resolver el correo registrado.',
      )
    try {
      const response = await this.request(`${this.baseUrl}/api/accounts/me`, {
        headers: { authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: 'error',
      })
      if (!response.ok)
        throw new IntegrationUnavailableError('No se pudo consultar la cuenta del comprador.')
      const data: unknown = await response.json()
      if (
        typeof data !== 'object' ||
        data === null ||
        !('email' in data) ||
        typeof data.email !== 'string' ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)
      )
        throw new IntegrationUnavailableError('La cuenta no tiene un correo registrado disponible.')
      return data.email
    } catch (error: unknown) {
      if (error instanceof IntegrationUnavailableError) throw error
      throw new IntegrationUnavailableError('No se pudo verificar el destinatario de la compra.')
    }
  }
}
