import { createServer, type Server, type IncomingHttpHeaders } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import {
  InternalJsonClient,
  HttpCatalogReservations,
  HttpInventoryGrant,
  HttpPurchaseMail,
} from '../../src/adapters/outbound/inventory/CommerceInternalClients'
import { HttpCatalogPricing } from '../../src/adapters/outbound/pricing/HttpCatalogPricing'
import { HttpPurchaseRecipient } from '../../src/adapters/outbound/identity/HttpPurchaseRecipient'
import { signInternalRequest } from '../../src/adapters/outbound/identity/internal-signature'
import {
  IntegrationRejectedError,
  IntegrationUnavailableError,
} from '../../src/application/ports/CommerceIntegrationPorts'

const id = '22222222-2222-4222-8222-222222222222'
const productId = '11111111-1111-4111-8111-111111111111'
const secret = 'integration-test-only'
const reservation = { reservationId: id, playerId: 'player-a', lines: [{ productId, quantity: 2 }] }
const grant = { operationId: id, playerId: 'player-a', items: reservation.lines }
const notification = {
  notificationId: id,
  orderId: id,
  recipient: 'registered@example.com',
  items: [{ productId, name: 'Espada', quantity: 2, unitPrice: 1250 }],
  currency: 'COP',
  total: 2500,
}
const product = {
  productId,
  sku: 'espada',
  name: 'Espada',
  imageUrl: 'https://example.com/a.png',
  premium: true,
  lifecycleStatus: 'ACTIVE',
  availableUnits: 10,
  realMoneyPrice: { amount: 1250, currency: 'COP' },
}

describe('Adaptadores HTTP de checkout', () => {
  let server: Server
  let baseUrl: string
  let response: { status: number; body: unknown }
  let captured: { path: string; method: string; headers: IncomingHttpHeaders; body: unknown }[]
  beforeAll(async () => {
    server = createServer((request, reply) => {
      void (async (): Promise<void> => {
        const chunks: Buffer[] = []
        for await (const chunk of request)
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
        const raw = Buffer.concat(chunks).toString('utf8')
        captured.push({
          path: request.url ?? '',
          method: request.method ?? '',
          headers: request.headers,
          body: raw.length === 0 ? null : (JSON.parse(raw) as unknown),
        })
        reply.writeHead(response.status, { 'content-type': 'application/json' })
        reply.end(JSON.stringify(response.body))
      })()
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
  })
  beforeEach(() => {
    captured = []
    response = { status: 200, body: {} }
  })
  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve()
      })
    })
  })
  const internal = (): InternalJsonClient => new InternalJsonClient(baseUrl, secret, 500)

  it('firma servicio, metodo, ruta, fecha y lote con el contrato canonico', async () => {
    response.body = { reservationId: id, state: 'RESERVED' }
    await new HttpCatalogReservations(internal()).reserve(reservation)
    const call = captured[0]!
    expect(call.path).toBe('/api/internal/v1/catalog/reservations')
    expect(call.body).toEqual(reservation)
    const timestamp = String(call.headers['x-internal-timestamp'])
    expect(call.headers['x-internal-service']).toBe('commerce')
    expect(call.headers['x-internal-signature']).toBe(
      signInternalRequest(secret, {
        service: 'commerce',
        method: 'POST',
        path: call.path,
        timestamp,
        body: reservation,
      }),
    )
    expect(call.headers.authorization).toBeUndefined()
    response.body = { reservationId: id, state: 'CONFIRMED' }
    await new HttpCatalogReservations(internal()).reserve(reservation)
  })

  it('solo el codigo terminal RESERVATION_REJECTED autoriza compensacion', async () => {
    const catalog = new HttpCatalogReservations(internal())
    for (const status of [404, 409]) {
      response = { status, body: { code: 'RESERVATION_REJECTED' } }
      await expect(catalog.reserve(reservation)).rejects.toBeInstanceOf(IntegrationRejectedError)
    }
    for (const status of [400, 401, 409, 500, 503]) {
      response = { status, body: { error: 'unknown' } }
      await expect(catalog.reserve(reservation)).rejects.toBeInstanceOf(IntegrationUnavailableError)
    }
    response = { status: 200, body: { reservationId: 'other', state: 'RESERVED' } }
    await expect(catalog.reserve(reservation)).rejects.toBeInstanceOf(IntegrationUnavailableError)
  })

  it('confirmacion y liberacion requieren estado e identificador exactos', async () => {
    const catalog = new HttpCatalogReservations(internal())
    response.body = { reservationId: id, state: 'CONFIRMED' }
    await catalog.confirm(id, 'player-a')
    expect(captured[0]?.path).toBe(`/api/internal/v1/catalog/reservations/${id}/confirmation`)
    expect(captured[0]?.body).toEqual({ playerId: 'player-a' })
    response.body = { reservationId: id, state: 'RELEASED' }
    await catalog.release(id, 'player-a')
    expect(captured[1]?.path).toBe(`/api/internal/v1/catalog/reservations/${id}/release`)
    response.body = { reservationId: id, state: 'RESERVED' }
    await expect(catalog.confirm(id, 'player-a')).rejects.toBeInstanceOf(
      IntegrationUnavailableError,
    )
    await expect(catalog.release(id, 'player-a')).rejects.toBeInstanceOf(
      IntegrationUnavailableError,
    )
  })

  it('Inventory usa grant de lote y distingue422terminal de409incierto', async () => {
    const inventory = new HttpInventoryGrant(internal())
    response.body = { ...grant, applied: true }
    await inventory.grant(grant)
    expect(captured[0]?.path).toBe('/api/internal/v1/inventory/grants')
    expect(captured[0]?.body).toEqual(grant)
    response = { status: 422, body: { code: 'INVENTORY_REJECTED' } }
    await expect(inventory.grant(grant)).rejects.toBeInstanceOf(IntegrationRejectedError)
    response = { status: 409, body: { code: 'INVENTORY_REJECTED' } }
    await expect(inventory.grant(grant)).rejects.toBeInstanceOf(IntegrationUnavailableError)
    response = { status: 422, body: { error: 'capacity' } }
    await expect(inventory.grant(grant)).rejects.toBeInstanceOf(IntegrationUnavailableError)
    response = { status: 200, body: { operationId: id, applied: false } }
    await expect(inventory.grant(grant)).rejects.toBeInstanceOf(IntegrationUnavailableError)
  })

  it('outbox no confirma correo hasta recibir SENT con su notificationId', async () => {
    const mail = new HttpPurchaseMail(internal())
    response.body = { notificationId: id, status: 'SENT' }
    await mail.send(notification)
    expect(captured[0]?.path).toBe('/api/internal/v1/notifications/purchases')
    expect(captured[0]?.body).toEqual(notification)
    response.body = { notificationId: id, status: 'QUEUED' }
    await expect(mail.send(notification)).rejects.toBeInstanceOf(IntegrationUnavailableError)
    response = { status: 503, body: { error: 'purchase_pending' } }
    await expect(mail.send(notification)).rejects.toBeInstanceOf(IntegrationUnavailableError)
  })

  it('red incierta o JSON incompatible nunca se convierten en rechazo terminal', async () => {
    const network = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockRejectedValue(new Error('connection reset'))
    await expect(
      new InternalJsonClient(baseUrl, secret, 500, network).post('/x', {}),
    ).rejects.toBeInstanceOf(IntegrationUnavailableError)
    const invalidJson = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockResolvedValue(new Response('invalid', { status: 200 }))
    await expect(
      new InternalJsonClient(baseUrl, secret, 500, invalidJson).post('/x', {}),
    ).rejects.toBeInstanceOf(IntegrationUnavailableError)
  })

  it('Catalog devuelve ID canonico, precio en unidades menores y metadatos', async () => {
    const pricing = new HttpCatalogPricing(baseUrl, 500)
    response.body = product
    expect(await pricing.priceOf('espada')).toEqual({
      productId,
      sku: 'espada',
      name: 'Espada',
      imageUrl: product.imageUrl,
      amount: 1250,
      currency: 'COP',
      availableUnits: 10,
    })
    expect(captured[0]?.path).toBe('/api/v1/catalog/products/espada')
    expect(captured[0]?.headers.authorization).toBeUndefined()
    response = { status: 404, body: {} }
    expect(await pricing.priceOf(productId)).toBeNull()
    for (const unavailableProduct of [
      { ...product, premium: false },
      { ...product, lifecycleStatus: 'SUSPENDED' },
      { ...product, realMoneyPrice: null },
    ]) {
      response = { status: 200, body: unavailableProduct }
      expect(await pricing.priceOf(productId)).toBeNull()
    }
  })

  it('Catalog rechaza precios, stock e identidades malformados sin recurrir a demo', async () => {
    const pricing = new HttpCatalogPricing(baseUrl, 500)
    for (const invalid of [
      null,
      {},
      { ...product, productId: 'legacy' },
      { ...product, availableUnits: -1 },
      { ...product, realMoneyPrice: { amount: 1.2, currency: 'COP' } },
      { ...product, realMoneyPrice: { amount: 1250, currency: 'GOLD' } },
    ]) {
      response = { status: 200, body: invalid }
      await expect(pricing.priceOf(productId)).rejects.toBeInstanceOf(IntegrationUnavailableError)
    }
    response = { status: 503, body: {} }
    await expect(pricing.priceOf(productId)).rejects.toBeInstanceOf(IntegrationUnavailableError)
    const network = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockRejectedValue(new Error('offline'))
    await expect(
      new HttpCatalogPricing(baseUrl, 500, network).priceOf(productId),
    ).rejects.toBeInstanceOf(IntegrationUnavailableError)
  })

  it('Account recibe JWT de la sesion y el correo sale exclusivamente de /me', async () => {
    const recipient = new HttpPurchaseRecipient(baseUrl, 500)
    response.body = { email: 'registered@example.com' }
    expect(await recipient.resolve('player-a', 'session-token')).toBe('registered@example.com')
    expect(captured[0]?.path).toBe('/api/accounts/me')
    expect(captured[0]?.headers.authorization).toBe('Bearer session-token')
    await expect(recipient.resolve('player-a', '')).rejects.toBeInstanceOf(
      IntegrationUnavailableError,
    )
    expect(captured).toHaveLength(1)
    response.body = { email: 'not an address' }
    await expect(recipient.resolve('player-a', 'session-token')).rejects.toBeInstanceOf(
      IntegrationUnavailableError,
    )
    response = { status: 401, body: {} }
    await expect(recipient.resolve('player-a', 'session-token')).rejects.toBeInstanceOf(
      IntegrationUnavailableError,
    )
    const network = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockRejectedValue(new Error('offline'))
    await expect(
      new HttpPurchaseRecipient(baseUrl, 500, network).resolve('player-a', 'token'),
    ).rejects.toBeInstanceOf(IntegrationUnavailableError)
  })
})
