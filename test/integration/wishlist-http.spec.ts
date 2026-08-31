import 'reflect-metadata'

import { ValidationPipe, type INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'

import { AppModule } from '../../src/infrastructure/bootstrap/app.module'

/**
 * Pruebas de integracion sobre la aplicacion NestJS real, igual que
 * `orders-http.spec.ts`: se levanta el modulo completo y no se sustituye
 * ningun adaptador.
 */
describe('API de la lista de deseos', () => {
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

  const addItem = (sku: string) => request(app.getHttpServer()).post(`/api/wishlist/${sku}`)
  const removeItem = (sku: string) => request(app.getHttpServer()).delete(`/api/wishlist/${sku}`)
  const statusOf = (sku: string) => request(app.getHttpServer()).get(`/api/wishlist/${sku}`)
  const listWishlist = () => request(app.getHttpServer()).get('/api/wishlist')

  it('GET /api/wishlist/:sku responde enDeseos y adquirido en falso para una referencia nueva', async () => {
    const response = await statusOf('referencia-nunca-vista')

    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      sku: 'referencia-nunca-vista',
      enDeseos: false,
      adquirido: false,
    })
  })

  it('POST /api/wishlist/:sku anade la referencia y responde 200', async () => {
    const response = await addItem('espada-de-hierro')

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ sku: 'espada-de-hierro', enDeseos: true, adquirido: false })
  })

  it('anadir dos veces la misma referencia es idempotente', async () => {
    await addItem('pocion-de-vida')
    const response = await addItem('pocion-de-vida')

    expect(response.status).toBe(200)
    expect(response.body.enDeseos).toBe(true)
  })

  it('POST /api/wishlist/:sku responde 400 con una referencia mal formada', async () => {
    expect((await addItem('Espada_Hierro')).status).toBe(400)
  })

  it('DELETE /api/wishlist/:sku retira la referencia', async () => {
    await addItem('escudo-de-madera')

    const response = await removeItem('escudo-de-madera')

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ sku: 'escudo-de-madera', enDeseos: false, adquirido: false })
    expect((await statusOf('escudo-de-madera')).body.enDeseos).toBe(false)
  })

  it('DELETE /api/wishlist/:sku responde 400 si la referencia no estaba en la lista', async () => {
    expect((await removeItem('nunca-anadida')).status).toBe(400)
  })

  it('GET /api/wishlist lista solo las referencias deseadas por quien realiza la peticion', async () => {
    const before = await listWishlist()
    await addItem('yelmo-de-bronce')

    const response = await listWishlist()

    expect(response.status).toBe(200)
    expect(response.body).toHaveLength((before.body as unknown[]).length + 1)
    expect(response.body).toContainEqual({
      sku: 'yelmo-de-bronce',
      enDeseos: true,
      adquirido: false,
    })
  })

  it('marca adquirido tras confirmar un pedido con esa referencia', async () => {
    // Tiene que existir en el catalogo de precios: sin precio, AddOrderLine
    // rechaza la linea y el pedido nunca llega a confirmarse.
    const sku = 'arco-corto'
    await addItem(sku)

    const order = await request(app.getHttpServer()).post('/api/orders').send({ currency: 'COP' })
    const orderId = String(order.body.id)
    await request(app.getHttpServer())
      .post(`/api/orders/${orderId}/lines`)
      .send({ sku, quantity: 1 })
    await request(app.getHttpServer()).post(`/api/orders/${orderId}/confirmation`)

    const response = await statusOf(sku)

    expect(response.body).toEqual({ sku, enDeseos: true, adquirido: true })
  })

  it('un pedido en borrador con la referencia no cuenta como adquirido', async () => {
    const sku = 'escudo-de-roble'
    const order = await request(app.getHttpServer()).post('/api/orders').send({ currency: 'COP' })
    await request(app.getHttpServer())
      .post(`/api/orders/${String(order.body.id)}/lines`)
      .send({ sku, quantity: 1 })

    expect((await statusOf(sku)).body.adquirido).toBe(false)
  })
})
