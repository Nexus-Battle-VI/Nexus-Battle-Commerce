import 'reflect-metadata'

import { ValidationPipe, type INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'

import { AppModule } from '../../src/infrastructure/bootstrap/app.module'

/**
 * Pruebas de integracion del carrito sobre la aplicacion NestJS real.
 *
 * Con `AUTH_MODE=disabled` todas las peticiones comparten la identidad
 * anonima, asi que el carrito es el mismo entre pruebas: cada caso parte de
 * vaciarlo o trabaja con incrementos, no asume un carrito nuevo.
 */
describe('API del carrito', () => {
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

  const openCart = (currency = 'COP') =>
    request(app.getHttpServer()).post('/api/orders/cart').send({ currency })
  const readCart = () => request(app.getHttpServer()).get('/api/orders/cart')
  const addLine = (orderId: string, sku: string, quantity: number) =>
    request(app.getHttpServer()).post(`/api/orders/${orderId}/lines`).send({ sku, quantity })
  const setQuantity = (orderId: string, sku: string, quantity: number) =>
    request(app.getHttpServer()).patch(`/api/orders/${orderId}/lines/${sku}`).send({ quantity })

  /** Deja el carrito vigente sin lineas, para partir de un estado conocido. */
  const emptyCart = async (): Promise<string> => {
    const cart = await openCart()
    const id = String(cart.body.id)

    for (const line of cart.body.lines as { sku: string }[]) {
      await request(app.getHttpServer()).delete(`/api/orders/${id}/lines/${line.sku}`)
    }

    return id
  }

  it('POST /api/orders/cart abre un carrito y es idempotente', async () => {
    const first = await openCart()
    const second = await openCart()

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(second.body.id).toBe(first.body.id)
    expect(second.body.status).toBe('DRAFT')
  })

  it('POST /api/orders/cart responde 400 con una moneda no soportada', async () => {
    expect((await openCart('GBP')).status).toBe(400)
  })

  it('GET /api/orders/cart devuelve el carrito vigente con itemCount', async () => {
    const id = await emptyCart()
    await addLine(id, 'espada-de-hierro', 2)

    const response = await readCart()

    expect(response.status).toBe(200)
    expect(response.body.id).toBe(id)
    expect(response.body.itemCount).toBe(2)
    expect(response.body.total).toBe(30_000)
  })

  it('itemCount suma cantidades y no referencias', async () => {
    const id = await emptyCart()
    await addLine(id, 'espada-de-hierro', 2)
    await addLine(id, 'pocion-de-vida', 3)

    const response = await readCart()

    expect(response.body.lines).toHaveLength(2)
    expect(response.body.itemCount).toBe(5)
  })

  it('PATCH fija la cantidad exacta y recalcula subtotal y total', async () => {
    const id = await emptyCart()
    await addLine(id, 'espada-de-hierro', 1)

    const response = await setQuantity(id, 'espada-de-hierro', 4)

    expect(response.status).toBe(200)
    expect(response.body.lines[0]).toEqual({
      sku: 'espada-de-hierro',
      unitPrice: 15_000,
      quantity: 4,
      subtotal: 60_000,
    })
    expect(response.body.total).toBe(60_000)
  })

  it('PATCH permite reducir la cantidad', async () => {
    const id = await emptyCart()
    await addLine(id, 'espada-de-hierro', 5)

    const response = await setQuantity(id, 'espada-de-hierro', 2)

    expect(response.body.itemCount).toBe(2)
    expect(response.body.total).toBe(30_000)
  })

  it('PATCH responde 400 con cantidad invalida y 404 con pedido inexistente', async () => {
    const id = await emptyCart()
    await addLine(id, 'espada-de-hierro', 1)

    expect((await setQuantity(id, 'espada-de-hierro', 0)).status).toBe(400)
    expect((await setQuantity(id, 'pocion-de-vida', 1)).status).toBe(400)
    expect((await setQuantity('inexistente', 'espada-de-hierro', 1)).status).toBe(404)
  })

  it('PATCH rechaza campos no declarados en el contrato', async () => {
    const id = await emptyCart()
    await addLine(id, 'espada-de-hierro', 1)

    const response = await request(app.getHttpServer())
      .patch(`/api/orders/${id}/lines/espada-de-hierro`)
      .send({ quantity: 2, unitPrice: 1 })

    expect(response.status).toBe(400)
  })

  it('eliminar una linea recalcula el total con el contenido restante', async () => {
    const id = await emptyCart()
    await addLine(id, 'espada-de-hierro', 1)
    await addLine(id, 'pocion-de-vida', 2)

    const response = await request(app.getHttpServer()).delete(
      `/api/orders/${id}/lines/espada-de-hierro`,
    )

    expect(response.status).toBe(200)
    expect(response.body.lines).toHaveLength(1)
    expect(response.body.total).toBe(4_000)
    expect(response.body.itemCount).toBe(2)
  })

  /**
   * CP-58-03: el contenido sobrevive a abandonar el modulo y volver. Aqui eso
   * se ejercita releyendo el carrito en una peticion posterior e
   * independiente.
   */
  it('el carrito conserva su contenido entre peticiones', async () => {
    const id = await emptyCart()
    await addLine(id, 'espada-de-hierro', 3)

    const later = await readCart()

    expect(later.body.id).toBe(id)
    expect(later.body.itemCount).toBe(3)
  })

  it('un pedido confirmado deja de ser el carrito vigente', async () => {
    const id = await emptyCart()
    await addLine(id, 'espada-de-hierro', 1)
    await request(app.getHttpServer()).post(`/api/orders/${id}/confirmation`)

    const next = await openCart()

    expect(next.body.id).not.toBe(id)
    expect(next.body.itemCount).toBe(0)
  })
})
