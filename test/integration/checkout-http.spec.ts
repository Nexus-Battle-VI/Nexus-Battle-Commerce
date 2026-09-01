import 'reflect-metadata'

import { ValidationPipe, type INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'

import { AppModule } from '../../src/infrastructure/bootstrap/app.module'

const VALID_CARD = {
  holder: 'Ana Gomez',
  number: '4111111111111111',
  expiry: '12/30',
  securityCode: '123',
}

/**
 * Pruebas de integracion del pago simulado sobre la aplicacion NestJS real.
 *
 * No se sustituye ningun adaptador: la pasarela y el inventario que operan son
 * los que registra la raiz de composicion.
 */
describe('API del pago simulado', () => {
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
   * Carrito vigente con espada x2 y pocion x1: 32.000.
   *
   * Se usa el carrito (`POST /api/orders/cart`) y no `POST /api/orders`: con
   * `AUTH_MODE=disabled` todas las peticiones comparten la identidad anonima,
   * asi que abrir un pedido suelto por prueba dejaria varios borradores vivos
   * del mismo cliente y «el carrito vigente» seria cualquiera de ellos. Con el
   * carrito hay exactamente un borrador, y se vacia antes de llenarlo para
   * partir de un estado conocido.
   */
  const orderReadyToPay = async (): Promise<string> => {
    const cart = await request(app.getHttpServer())
      .post('/api/orders/cart')
      .send({ currency: 'COP' })
    const id = String(cart.body.id)

    for (const line of cart.body.lines as { sku: string }[]) {
      await request(app.getHttpServer()).delete(`/api/orders/${id}/lines/${line.sku}`)
    }

    await request(app.getHttpServer())
      .post(`/api/orders/${id}/lines`)
      .send({ sku: 'espada-de-hierro', quantity: 2 })
    await request(app.getHttpServer())
      .post(`/api/orders/${id}/lines`)
      .send({ sku: 'pocion-de-vida', quantity: 1 })

    return id
  }

  const pay = (orderId: string, card: Record<string, unknown> = VALID_CARD) =>
    request(app.getHttpServer()).post(`/api/orders/${orderId}/payment`).send(card)

  it('GET checkout devuelve el resumen con los productos vigentes y el total', async () => {
    const id = await orderReadyToPay()

    const response = await request(app.getHttpServer()).get(`/api/orders/${id}/checkout`)

    expect(response.status).toBe(200)
    expect(response.body.lines).toHaveLength(2)
    expect(response.body.total).toBe(32_000)
    expect(response.body.itemCount).toBe(3)
  })

  it('GET checkout responde 404 con un pedido inexistente', async () => {
    expect(
      (await request(app.getHttpServer()).get('/api/orders/inexistente/checkout')).status,
    ).toBe(404)
  })

  /** CP-59-01 por HTTP. */
  it('el pago completa la compra y declara que no hubo movimiento real', async () => {
    const id = await orderReadyToPay()

    const response = await pay(id)

    expect(response.status).toBe(200)
    expect(response.body.order.status).toBe('CONFIRMED')
    expect(response.body.order.total).toBe(32_000)
    expect(response.body.paymentReference).toBe(`sim-${id}`)
    expect(response.body.realMoneyMoved).toBe(false)
  })

  it('la respuesta no contiene el numero de tarjeta', async () => {
    const id = await orderReadyToPay()

    const response = await pay(id)

    expect(JSON.stringify(response.body)).not.toContain(VALID_CARD.number)
    expect(response.body.maskedCard).toBe('1111')
  })

  it('tras pagar, el carrito vigente queda vacio', async () => {
    const id = await orderReadyToPay()
    await pay(id)

    const cart = await request(app.getHttpServer())
      .post('/api/orders/cart')
      .send({ currency: 'COP' })

    expect(cart.body.id).not.toBe(id)
    expect(cart.body.itemCount).toBe(0)
  })

  /** CP-59-02: falta uno de los cuatro datos documentados. */
  it.each([['holder'], ['number'], ['expiry'], ['securityCode']])(
    'responde 400 cuando falta %s y no aplica la compra',
    async (missing) => {
      const id = await orderReadyToPay()
      const card = Object.fromEntries(
        Object.entries(VALID_CARD).filter(([field]) => field !== missing),
      )

      expect((await pay(id, card)).status).toBe(400)

      // El pedido sigue en borrador: nada de una compra exitosa se aplico.
      const after = await request(app.getHttpServer()).get(`/api/orders/${id}`)
      expect(after.body.status).toBe('DRAFT')
    },
  )

  it('responde 400 con datos de tarjeta mal formados', async () => {
    const id = await orderReadyToPay()

    expect((await pay(id, { ...VALID_CARD, expiry: '13/30' })).status).toBe(400)
    expect((await pay(id, { ...VALID_CARD, securityCode: '12' })).status).toBe(400)
    expect((await pay(id, { ...VALID_CARD, number: 'abcd' })).status).toBe(400)
  })

  it('rechaza campos no declarados en el contrato', async () => {
    const id = await orderReadyToPay()

    expect((await pay(id, { ...VALID_CARD, amount: 1 })).status).toBe(400)
  })

  /** La tarjeta reservada para el camino de rechazo. */
  it('responde 402 cuando la pasarela rechaza, sin aplicar la compra', async () => {
    const id = await orderReadyToPay()

    const response = await pay(id, { ...VALID_CARD, number: '4111111111110000' })

    expect(response.status).toBe(402)

    const after = await request(app.getHttpServer()).get(`/api/orders/${id}`)
    expect(after.body.status).toBe('DRAFT')
    expect(after.body.total).toBe(32_000)
  })

  it('responde 400 al pagar un pedido sin lineas', async () => {
    const id = await orderReadyToPay()

    for (const sku of ['espada-de-hierro', 'pocion-de-vida']) {
      await request(app.getHttpServer()).delete(`/api/orders/${id}/lines/${sku}`)
    }

    expect((await pay(id)).status).toBe(400)
  })

  it('responde 404 al pagar un pedido inexistente', async () => {
    expect((await pay('inexistente')).status).toBe(404)
  })

  it('responde 400 al pagar dos veces el mismo pedido', async () => {
    const id = await orderReadyToPay()
    await pay(id)

    expect((await pay(id)).status).toBe(400)
  })
})
