import 'reflect-metadata'

import { ValidationPipe, type INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'

import { AppModule } from '../../src/infrastructure/bootstrap/app.module'

/**
 * Pruebas de integracion sobre la aplicacion NestJS real: se levanta el modulo
 * completo, con su raiz de composicion, sus tuberias de validacion y sus
 * controladores. No se sustituye ningun adaptador.
 */
describe('API de comercio', () => {
  let app: INestApplication

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()

    app = moduleRef.createNestApplication()
    app.setGlobalPrefix('api')
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    )

    await app.init()
  })

  afterAll(async () => {
    await app.close()
  })

  /**
   * Ninguna peticion declara el cliente: sale del testimonio. Con
   * AUTH_MODE=disabled ese testimonio es la identidad anonima, y el cliente que
   * queda registrado es literalmente `anonymous`.
   */
  const ANONYMOUS = 'anonymous'

  const createOrder = (currency = 'COP') =>
    request(app.getHttpServer()).post('/api/orders').send({ currency })

  const addLine = (orderId: string, sku: string, quantity: number) =>
    request(app.getHttpServer()).post(`/api/orders/${orderId}/lines`).send({ sku, quantity })

  it('POST /api/orders abre un pedido vacio y responde 201', async () => {
    const response = await createOrder()

    expect(response.status).toBe(201)
    expect(response.body).toMatchObject({
      customerId: ANONYMOUS,
      status: 'DRAFT',
      currency: 'COP',
      total: 0,
      lines: [],
    })
  })

  it('POST /api/orders responde 400 con una moneda no soportada', async () => {
    expect((await createOrder('GBP')).status).toBe(400)
  })

  it('POST /api/orders rechaza campos no declarados en el contrato', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/orders')
      .send({ currency: 'COP', total: 1 })

    expect(response.status).toBe(400)
  })

  it('anade lineas y calcula el total como suma de subtotales', async () => {
    const order = await createOrder()
    const id = String(order.body.id)

    await addLine(id, 'espada-de-hierro', 2)
    const response = await addLine(id, 'pocion-de-vida', 3)

    expect(response.status).toBe(200)
    expect(response.body.lines).toEqual([
      { sku: 'espada-de-hierro', unitPrice: 15_000, quantity: 2, subtotal: 30_000 },
      { sku: 'pocion-de-vida', unitPrice: 2_000, quantity: 3, subtotal: 6_000 },
    ])
    expect(response.body.total).toBe(36_000)
  })

  it('el precio lo determina el catalogo: el contrato no lo acepta', async () => {
    const order = await createOrder()
    const id = String(order.body.id)

    const response = await request(app.getHttpServer())
      .post(`/api/orders/${id}/lines`)
      .send({ sku: 'espada-de-hierro', quantity: 1, unitPrice: 1 })

    expect(response.status).toBe(400)
  })

  it('responde 422 con un producto que no esta en el catalogo', async () => {
    const order = await createOrder()

    expect((await addLine(String(order.body.id), 'producto-inexistente', 1)).status).toBe(422)
  })

  it('responde 404 al anadir a un pedido inexistente', async () => {
    expect((await addLine('inexistente', 'espada-de-hierro', 1)).status).toBe(404)
  })

  it('responde 400 con una cantidad no positiva o una referencia mal formada', async () => {
    const order = await createOrder()
    const id = String(order.body.id)

    expect((await addLine(id, 'espada-de-hierro', 0)).status).toBe(400)
    expect((await addLine(id, 'Espada_Hierro', 1)).status).toBe(400)
  })

  it('retira una referencia y recalcula el total', async () => {
    const order = await createOrder()
    const id = String(order.body.id)
    await addLine(id, 'espada-de-hierro', 1)
    await addLine(id, 'pocion-de-vida', 2)

    const response = await request(app.getHttpServer()).delete(
      `/api/orders/${id}/lines/espada-de-hierro`,
    )

    expect(response.status).toBe(200)
    expect(response.body.lines).toHaveLength(1)
    expect(response.body.total).toBe(4_000)
  })

  it('confirma el pedido y a partir de ahi queda congelado', async () => {
    const order = await createOrder()
    const id = String(order.body.id)
    await addLine(id, 'espada-de-hierro', 2)

    const confirm = await request(app.getHttpServer()).post(`/api/orders/${id}/confirmation`)
    expect(confirm.status).toBe(200)
    expect(confirm.body.status).toBe('CONFIRMED')
    expect(confirm.body.total).toBe(30_000)

    // Ninguna modificacion posterior es aceptada.
    expect((await addLine(id, 'pocion-de-vida', 1)).status).toBe(400)
    expect(
      (await request(app.getHttpServer()).delete(`/api/orders/${id}/lines/espada-de-hierro`))
        .status,
    ).toBe(400)
    expect((await request(app.getHttpServer()).post(`/api/orders/${id}/confirmation`)).status).toBe(
      400,
    )
  })

  it('responde 400 al confirmar un pedido vacio y 404 si no existe', async () => {
    const order = await createOrder()

    expect(
      (await request(app.getHttpServer()).post(`/api/orders/${String(order.body.id)}/confirmation`))
        .status,
    ).toBe(400)
    expect(
      (await request(app.getHttpServer()).post('/api/orders/inexistente/confirmation')).status,
    ).toBe(404)
  })

  it('cancela el pedido con un motivo', async () => {
    const order = await createOrder()
    const id = String(order.body.id)
    await addLine(id, 'espada-de-hierro', 1)

    const response = await request(app.getHttpServer())
      .post(`/api/orders/${id}/cancellation`)
      .send({ reason: 'Sin existencias' })

    expect(response.status).toBe(200)
    expect(response.body.status).toBe('CANCELLED')
  })

  it('responde 400 al cancelar dos veces y 404 si el pedido no existe', async () => {
    const order = await createOrder()
    const id = String(order.body.id)
    await request(app.getHttpServer())
      .post(`/api/orders/${id}/cancellation`)
      .send({ reason: 'Motivo' })

    expect(
      (
        await request(app.getHttpServer())
          .post(`/api/orders/${id}/cancellation`)
          .send({ reason: 'Otro' })
      ).status,
    ).toBe(400)
    expect(
      (
        await request(app.getHttpServer())
          .post('/api/orders/inexistente/cancellation')
          .send({ reason: 'Motivo' })
      ).status,
    ).toBe(404)
  })

  it('GET /api/orders/:id responde 404 si el pedido no existe', async () => {
    expect((await request(app.getHttpServer()).get('/api/orders/inexistente')).status).toBe(404)
  })

  it('GET /api/orders lista los pedidos de quien realiza la peticion', async () => {
    const before = await request(app.getHttpServer()).get('/api/orders')

    await createOrder()
    await createOrder()

    const response = await request(app.getHttpServer()).get('/api/orders')

    expect(response.status).toBe(200)
    expect(response.body).toHaveLength((before.body as unknown[]).length + 2)
  })

  /**
   * El parametro `customerId` desaparecio del contrato. Listar los pedidos de
   * otra persona era cuestion de cambiar un valor en la cadena de consulta.
   */
  it('ignora un intento de listar los pedidos de otra persona', async () => {
    const propios = await request(app.getHttpServer()).get('/api/orders')
    const ajenos = await request(app.getHttpServer()).get('/api/orders?customerId=acc-de-otro')

    expect(ajenos.status).toBe(200)
    expect(ajenos.body).toEqual(propios.body)
  })

  it('GET /api/orders ya no exige identificador de cliente: lo toma del testimonio', async () => {
    expect((await request(app.getHttpServer()).get('/api/orders')).status).toBe(200)
  })
})

describe('Sondas de salud', () => {
  let app: INestApplication

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()

    app = moduleRef.createNestApplication()
    app.setGlobalPrefix('api')
    await app.init()
  })

  afterAll(async () => {
    await app.close()
  })

  it('GET /api/health/live responde 200', async () => {
    expect((await request(app.getHttpServer()).get('/api/health/live')).body).toEqual({
      status: 'ok',
      checks: {},
    })
  })

  it('GET /api/health/ready evalua repositorio y catalogo de precios', async () => {
    const response = await request(app.getHttpServer()).get('/api/health/ready')

    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      status: 'ok',
      checks: {
        'orders-repository': 'ok',
        'wishlist-repository': 'ok',
        'catalog-pricing': 'ok',
      },
    })
  })

  it('GET /api/version expone servicio, version y entorno', async () => {
    expect((await request(app.getHttpServer()).get('/api/version')).body).toMatchObject({
      service: 'nexus-battle-commerce',
    })
  })
})
