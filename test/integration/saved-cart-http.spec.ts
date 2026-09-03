import 'reflect-metadata'

import { ValidationPipe, type INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'

import { AppModule } from '../../src/infrastructure/bootstrap/app.module'
import {
  Role,
  TOKEN_VERIFIER,
  TokenVerificationError,
  type TokenVerifierPort,
} from '../../src/application/ports/TokenVerifierPort'
import {
  PRODUCT_PRICING,
  type ProductPricingPort,
} from '../../src/application/ports/ProductPricingPort'

/**
 * Pruebas de integracion del carrito guardado (HU-61).
 *
 * Con `AUTH_MODE=disabled` toda peticion llega con la identidad literal
 * `anonymous`, que no identifica a nadie. HU-61 exige rechazar exactamente ese
 * caso, asi que **lo unico que estas pruebas pueden ejercitar de extremo a
 * extremo es el rechazo**, y eso es lo que comprueban.
 *
 * La segunda suite verifica la recuperacion entre testimonios del mismo sujeto
 * y el aislamiento usando un verificador sustituido, sin contactar a Cognito.
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

  it('la sonda local declara el modo de desarrollo', async () => {
    const response = await request(app.getHttpServer()).get('/api/health/ready')

    expect(response.status).toBe(200)
    expect(response.body.checks['development-mode']).toBe('ok')
  })
})

describe('Carrito guardado con identidades verificadas entre sesiones', () => {
  let app: INestApplication
  let previous: Record<string, string | undefined>
  let stock: number
  const productId = '72a3f0e1-78ad-4d1c-a641-e328529c4b41'
  const pricing: ProductPricingPort = {
    priceOf: (reference) =>
      Promise.resolve(
        [productId, 'espada-real'].includes(reference)
          ? {
              productId,
              sku: 'espada-real',
              name: 'Espada real',
              imageUrl: '/api/v1/catalog/assets/imagen',
              amount: 15000,
              currency: 'COP',
              availableUnits: stock,
            }
          : null,
      ),
  }
  const verifier: TokenVerifierPort = {
    verify: (token) => {
      const subject =
        token === 'sesion-a-1' || token === 'sesion-a-2'
          ? 'customer-a'
          : token === 'sesion-b'
            ? 'customer-b'
            : null
      return subject === null
        ? Promise.reject(new TokenVerificationError())
        : Promise.resolve({ subject, email: null, roles: new Set([Role.Player]) })
    },
  }
  beforeAll(async () => {
    previous = {
      AUTH_MODE: process.env.AUTH_MODE,
      COGNITO_USER_POOL_ID: process.env.COGNITO_USER_POOL_ID,
      COGNITO_CLIENT_ID: process.env.COGNITO_CLIENT_ID,
    }
    process.env.AUTH_MODE = 'jwt'
    process.env.COGNITO_USER_POOL_ID = 'us-east-1_pruebas'
    process.env.COGNITO_CLIENT_ID = 'cliente-de-pruebas'
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(TOKEN_VERIFIER)
      .useValue(verifier)
      .overrideProvider(PRODUCT_PRICING)
      .useValue(pricing)
      .compile()
    app = moduleRef.createNestApplication()
    app.setGlobalPrefix('api')
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    )
    await app.init()
  })
  afterAll(async () => {
    await app.close()
    for (const [key, value] of Object.entries(previous)) {
      process.env[key] = value ?? ''
    }
  })
  const api = () => request(app.getHttpServer())
  const bearer = (session: string) => `Bearer ${session}`

  it('guarda UUID y metadatos, recupera para el mismo sujeto y no los entrega a otro', async () => {
    stock = 4
    const cart = await api()
      .post('/api/orders/cart')
      .set('Authorization', bearer('sesion-a-1'))
      .send({ currency: 'COP' })
    expect(cart.status).toBe(200)
    const id = String(cart.body.id)
    expect(
      (
        await api()
          .post(`/api/orders/${id}/lines`)
          .set('Authorization', bearer('sesion-a-1'))
          .send({ productId, quantity: 2 })
      ).status,
    ).toBe(200)
    const saved = await api()
      .post('/api/orders/cart/persistence')
      .set('Authorization', bearer('sesion-a-1'))
    expect(saved.status).toBe(200)
    expect(saved.body.items[0]).toMatchObject({ productId, name: 'Espada real', quantity: 2 })
    expect(
      (
        await api()
          .post(`/api/orders/${id}/cancellation`)
          .set('Authorization', bearer('sesion-a-1'))
          .send({ reason: 'Cerrar borrador' })
      ).status,
    ).toBe(200)

    expect(
      (await api().get('/api/orders/cart/persistence').set('Authorization', bearer('sesion-b')))
        .status,
    ).toBe(404)
    expect(
      (
        await api()
          .post('/api/orders/cart/persistence/restoration')
          .set('Authorization', bearer('sesion-b'))
      ).status,
    ).toBe(404)
    await api().delete('/api/orders/cart/persistence').set('Authorization', bearer('sesion-b'))
    const later = await api()
      .get('/api/orders/cart/persistence')
      .set('Authorization', bearer('sesion-a-2'))
    expect(later.status).toBe(200)
    expect(later.body).toEqual(saved.body)
    const restored = await api()
      .post('/api/orders/cart/persistence/restoration')
      .set('Authorization', bearer('sesion-a-2'))
    expect(restored.status).toBe(200)
    expect(restored.body.id).not.toBe(id)
    expect(restored.body).toMatchObject({ customerId: 'customer-a', itemCount: 2, total: 30000 })
    expect(restored.body.lines[0]).toMatchObject({
      productId,
      sku: 'espada-real',
      name: 'Espada real',
    })
  })

  it('responde 409 ante falta de stock al restaurar y conserva borrador y copia', async () => {
    const before = await api().get('/api/orders/cart').set('Authorization', bearer('sesion-a-2'))
    stock = 1
    const result = await api()
      .post('/api/orders/cart/persistence/restoration')
      .set('Authorization', bearer('sesion-a-2'))
    expect(result.status).toBe(409)
    expect(
      (await api().get('/api/orders/cart').set('Authorization', bearer('sesion-a-2'))).body,
    ).toEqual(before.body)
    expect(
      (await api().get('/api/orders/cart/persistence').set('Authorization', bearer('sesion-a-2')))
        .body.itemCount,
    ).toBe(2)
  })
})
