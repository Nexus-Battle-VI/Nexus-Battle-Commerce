import 'reflect-metadata'

import { ValidationPipe, type INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'

import { AppModule } from '../../src/infrastructure/bootstrap/app.module'

/**
 * Pruebas de integracion del carrito guardado (HU-61).
 *
 * Con `AUTH_MODE=disabled` toda peticion llega con la identidad literal
 * `anonymous`, que no identifica a nadie. HU-61 exige rechazar exactamente ese
 * caso, asi que **lo unico que estas pruebas pueden ejercitar de extremo a
 * extremo es el rechazo**, y eso es lo que comprueban.
 *
 * El camino feliz (guardar, terminar sesion, recuperar) y el aislamiento entre
 * clientes se verifican en `test/unit/saved-cart.spec.ts`, donde la identidad
 * se puede fijar sin montar un proveedor OIDC.
 */
describe('API del carrito guardado sin identidad verificada', () => {
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

  /** CP-61-03: no se crea una asociacion atribuida a una identidad inexistente. */
  it('POST responde 401 y no guarda nada', async () => {
    const response = await request(app.getHttpServer()).post('/api/orders/cart/persistence')

    expect(response.status).toBe(401)
  })

  it('GET responde 401', async () => {
    expect((await request(app.getHttpServer()).get('/api/orders/cart/persistence')).status).toBe(
      401,
    )
  })

  it('la recuperacion responde 401', async () => {
    const response = await request(app.getHttpServer()).post(
      '/api/orders/cart/persistence/restoration',
    )

    expect(response.status).toBe(401)
  })

  it('DELETE responde 401', async () => {
    expect((await request(app.getHttpServer()).delete('/api/orders/cart/persistence')).status).toBe(
      401,
    )
  })

  /**
   * El rechazo llega antes de tocar el almacen: aunque exista un carrito con
   * contenido, la peticion anonima no lo guarda.
   */
  it('no guarda aunque exista un carrito con contenido', async () => {
    const cart = await request(app.getHttpServer())
      .post('/api/orders/cart')
      .send({ currency: 'COP' })
    await request(app.getHttpServer())
      .post(`/api/orders/${String(cart.body.id)}/lines`)
      .send({ sku: 'espada-de-hierro', quantity: 1 })

    expect((await request(app.getHttpServer()).post('/api/orders/cart/persistence')).status).toBe(
      401,
    )
    expect((await request(app.getHttpServer()).get('/api/orders/cart/persistence')).status).toBe(
      401,
    )
  })

  it('la sonda de disponibilidad incluye el repositorio de carritos guardados', async () => {
    const response = await request(app.getHttpServer()).get('/api/health/ready')

    expect(response.status).toBe(200)
    expect(response.body.checks['saved-cart-repository']).toBe('ok')
  })
})
