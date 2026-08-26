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
  type VerifiedIdentity,
} from '../../src/application/ports/TokenVerifierPort'

/**
 * Integracion con la autenticacion ACTIVA.
 *
 * Lo que se comprueba es concreto: antes, `customerId` lo declaraba el cliente
 * en el cuerpo y en la cadena de consulta. Cualquiera podia abrir pedidos a
 * nombre de otra persona, listar los suyos y confirmarlos.
 */
const IDENTITIES: Readonly<Record<string, VerifiedIdentity>> = {
  'token-ana': { subject: 'sujeto-ana', email: null, roles: new Set([Role.Player]) },
  'token-bruno': { subject: 'sujeto-bruno', email: null, roles: new Set([Role.Player]) },
  'token-administrador': {
    subject: 'sujeto-admin',
    email: null,
    roles: new Set([Role.Player, Role.Administrator]),
  },
}

const stubVerifier: TokenVerifierPort = {
  verify: (token: string): Promise<VerifiedIdentity> => {
    const identity = IDENTITIES[token]

    return identity === undefined
      ? Promise.reject(new TokenVerificationError())
      : Promise.resolve(identity)
  },
}

describe('API de comercio con autenticacion activa', () => {
  let app: INestApplication
  let previousEnv: Record<string, string | undefined>

  beforeAll(async () => {
    previousEnv = {
      AUTH_MODE: process.env.AUTH_MODE,
      COGNITO_USER_POOL_ID: process.env.COGNITO_USER_POOL_ID,
      COGNITO_CLIENT_ID: process.env.COGNITO_CLIENT_ID,
    }

    process.env.AUTH_MODE = 'jwt'
    process.env.COGNITO_USER_POOL_ID = 'us-east-1_pruebas'
    process.env.COGNITO_CLIENT_ID = 'cliente-de-pruebas'

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(TOKEN_VERIFIER)
      .useValue(stubVerifier)
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

    for (const [key, value] of Object.entries(previousEnv)) {
      process.env[key] = value ?? ''
    }
  })

  const bearer = (token: string) => `Bearer ${token}`

  const abrirPedido = (token: string) =>
    request(app.getHttpServer())
      .post('/api/orders')
      .set('Authorization', bearer(token))
      .send({ currency: 'COP' })

  describe('Todo el servicio exige testimonio', () => {
    it('responde 401 al abrir un pedido sin testimonio', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/orders')
        .send({ currency: 'COP' })

      expect(response.status).toBe(401)
    })

    it('responde 401 al listar sin testimonio', async () => {
      expect((await request(app.getHttpServer()).get('/api/orders')).status).toBe(401)
    })
  })

  describe('El cliente sale del testimonio, no de la peticion', () => {
    it('registra como cliente el sujeto del testimonio', async () => {
      const response = await abrirPedido('token-ana')

      expect(response.status).toBe(201)
      expect(response.body).toMatchObject({ customerId: 'sujeto-ana' })
    })

    it('rechaza un intento de abrir un pedido a nombre de otra persona', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/orders')
        .set('Authorization', bearer('token-bruno'))
        .send({ currency: 'COP', customerId: 'sujeto-ana' })

      expect(response.status).toBe(400)
    })

    it('lista solo los pedidos propios', async () => {
      await abrirPedido('token-ana')
      await abrirPedido('token-bruno')

      const deBruno = await request(app.getHttpServer())
        .get('/api/orders')
        .set('Authorization', bearer('token-bruno'))

      expect(deBruno.status).toBe(200)
      expect(
        (deBruno.body as { customerId: string }[]).every((o) => o.customerId === 'sujeto-bruno'),
      ).toBe(true)
    })
  })

  describe('Un pedido ajeno no se puede leer ni tocar', () => {
    let orderId: string

    beforeAll(async () => {
      const pedido = await abrirPedido('token-ana')
      orderId = (pedido.body as { id: string }).id
    })

    /**
     * Responde 404 y no 403 a proposito: distinguirlos confirmaria que el
     * pedido existe, y con eso se pueden enumerar pedidos ajenos probando
     * identificadores.
     */
    it('responde 404 al leer un pedido de otra persona', async () => {
      const response = await request(app.getHttpServer())
        .get(`/api/orders/${orderId}`)
        .set('Authorization', bearer('token-bruno'))

      expect(response.status).toBe(404)
    })

    it.each([
      ['confirmar', 'confirmation'],
      ['cancelar', 'cancellation'],
    ])('responde 404 al %s un pedido de otra persona', async (_accion, segmento) => {
      const response = await request(app.getHttpServer())
        .post(`/api/orders/${orderId}/${segmento}`)
        .set('Authorization', bearer('token-bruno'))
        .send(segmento === 'cancellation' ? { reason: 'Motivo de prueba' } : {})

      expect(response.status).toBe(404)
    })

    it('permite leer el propio pedido', async () => {
      const response = await request(app.getHttpServer())
        .get(`/api/orders/${orderId}`)
        .set('Authorization', bearer('token-ana'))

      expect(response.status).toBe(200)
    })

    it('permite a un administrador leer un pedido ajeno', async () => {
      const response = await request(app.getHttpServer())
        .get(`/api/orders/${orderId}`)
        .set('Authorization', bearer('token-administrador'))

      expect(response.status).toBe(200)
    })
  })
})
