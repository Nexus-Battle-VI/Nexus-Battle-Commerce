import 'reflect-metadata'

import { ForbiddenException, UnauthorizedException, type ExecutionContext } from '@nestjs/common'
import type { Reflector } from '@nestjs/core'

import { toVerifiedIdentity } from '../../src/adapters/outbound/identity/CognitoTokenVerifier'
import { JwtAuthGuard } from '../../src/adapters/inbound/http/auth/jwt-auth.guard'
import { RolesGuard } from '../../src/adapters/inbound/http/auth/roles.guard'
import {
  ANONYMOUS_IDENTITY,
  AnonymousIdentityGuard,
} from '../../src/adapters/inbound/http/auth/anonymous.guard'
import { IS_PUBLIC, REQUIRED_ROLES } from '../../src/adapters/inbound/http/auth/decorators'
import {
  Role,
  TokenVerificationError,
  type TokenVerifierPort,
  type VerifiedIdentity,
} from '../../src/application/ports/TokenVerifierPort'
import { AuthMode, ConfigurationError, loadConfig } from '../../src/infrastructure/config/env'

interface FakeRequest {
  headers: Record<string, string | undefined>
  identity?: VerifiedIdentity
}

const contextFor = (request: FakeRequest, metadata: Record<string, unknown> = {}) => {
  const handler = (): void => undefined
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => handler,
    getClass: () => contextFor,
  } as unknown as ExecutionContext

  const reflector = {
    getAllAndOverride: (key: string) => metadata[key],
  } as unknown as Reflector

  return { context, reflector }
}

describe('Traduccion del token a identidad verificada', () => {
  it('acepta solo los grupos que corresponden a un rol conocido', () => {
    const identity = toVerifiedIdentity({
      sub: 'sujeto-1',
      'cognito:groups': ['ADMINISTRATOR', 'PLAYER', 'SUPERUSUARIO', 'admin'],
    })

    expect([...identity.roles].sort()).toEqual([Role.Administrator, Role.Player])
  })

  it('descarta el correo cuando el proveedor no lo declara verificado', () => {
    expect(toVerifiedIdentity({ sub: 's', email: 'a@b.test' }).email).toBeNull()
    expect(
      toVerifiedIdentity({ sub: 's', email: 'a@b.test', email_verified: false }).email,
    ).toBeNull()
  })

  it('acepta el correo verificado y lo normaliza', () => {
    expect(
      toVerifiedIdentity({ sub: 's', email: 'Ana@Nexus.TEST', email_verified: true }).email,
    ).toBe('ana@nexus.test')
  })

  it('no otorga ningun rol cuando el token no trae grupos', () => {
    expect(toVerifiedIdentity({ sub: 's' }).roles.size).toBe(0)
    expect(toVerifiedIdentity({ sub: 's', 'cognito:groups': 'ADMINISTRATOR' }).roles.size).toBe(0)
  })

  it('no inventa un sujeto cuando el token no lo trae', () => {
    expect(toVerifiedIdentity({}).subject).toBe('')
  })
})

describe('JwtAuthGuard', () => {
  const identity: VerifiedIdentity = {
    subject: 'sujeto-1',
    email: null,
    roles: new Set([Role.Player]),
  }

  const verifier = (impl: TokenVerifierPort['verify']): TokenVerifierPort => ({ verify: impl })

  it('deja pasar una ruta publica sin mirar la cabecera', async () => {
    const { context, reflector } = contextFor({ headers: {} }, { [IS_PUBLIC]: true })
    const guard = new JwtAuthGuard(
      reflector,
      verifier(() => Promise.reject(new Error('no deberia llamarse'))),
    )

    await expect(guard.canActivate(context)).resolves.toBe(true)
  })

  it.each([
    ['ausente', undefined],
    ['sin esquema', 'abc.def.ghi'],
    ['con esquema equivocado', 'Basic abc'],
    ['sin valor', 'Bearer '],
  ])('rechaza una cabecera %s', async (_caso, authorization) => {
    const { context, reflector } = contextFor({ headers: { authorization } })
    const guard = new JwtAuthGuard(
      reflector,
      verifier(() => Promise.resolve(identity)),
    )

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException)
  })

  it('acepta el esquema en cualquier combinacion de mayusculas', async () => {
    const request: FakeRequest = { headers: { authorization: 'bEaReR token-valido' } }
    const { context, reflector } = contextFor(request)
    const guard = new JwtAuthGuard(
      reflector,
      verifier(() => Promise.resolve(identity)),
    )

    await expect(guard.canActivate(context)).resolves.toBe(true)
    expect(request.identity).toEqual(identity)
  })

  it('traduce un fallo de verificacion a 401', async () => {
    const { context, reflector } = contextFor({ headers: { authorization: 'Bearer falso' } })
    const guard = new JwtAuthGuard(
      reflector,
      verifier(() => Promise.reject(new TokenVerificationError())),
    )

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException)
  })

  /**
   * Si el JWKS no se puede alcanzar, el testimonio no es invalido: es que NO SE
   * HA PODIDO COMPROBAR. Responder 401 afirmaria algo que no se sabe, y ademas
   * ocultaria una caida de red detras de un error de credenciales.
   */
  it('no convierte un fallo de red en 401', async () => {
    const { context, reflector } = contextFor({ headers: { authorization: 'Bearer t' } })
    const guard = new JwtAuthGuard(
      reflector,
      verifier(() => Promise.reject(new Error('JWKS inalcanzable'))),
    )

    await expect(guard.canActivate(context)).rejects.not.toBeInstanceOf(UnauthorizedException)
  })
})

describe('RolesGuard', () => {
  const identityWith = (...roles: readonly Role[]): VerifiedIdentity => ({
    subject: 's',
    email: null,
    roles: new Set(roles),
  })

  it('deja pasar cuando la ruta no exige ningun rol', () => {
    const { context, reflector } = contextFor({ headers: {} })
    expect(new RolesGuard(reflector).canActivate(context)).toBe(true)
  })

  it('deja pasar cuando la identidad tiene el rol exigido', () => {
    const { context, reflector } = contextFor(
      { headers: {}, identity: identityWith(Role.Administrator) },
      { [REQUIRED_ROLES]: [Role.Administrator] },
    )

    expect(new RolesGuard(reflector).canActivate(context)).toBe(true)
  })

  it('deniega cuando la identidad no tiene el rol exigido', () => {
    const { context, reflector } = contextFor(
      { headers: {}, identity: identityWith(Role.Player, Role.Moderator) },
      { [REQUIRED_ROLES]: [Role.Administrator] },
    )

    expect(() => new RolesGuard(reflector).canActivate(context)).toThrow(ForbiddenException)
  })

  /**
   * Sin identidad no se puede autorizar. Devolver `true` aqui convertiria un
   * fallo en el orden de los guards en una ruta abierta.
   */
  it('deniega cuando no hay identidad verificada en la peticion', () => {
    const { context, reflector } = contextFor(
      { headers: {} },
      { [REQUIRED_ROLES]: [Role.Administrator] },
    )

    expect(() => new RolesGuard(reflector).canActivate(context)).toThrow(ForbiddenException)
  })
})

describe('AnonymousIdentityGuard', () => {
  it('atribuye el sujeto literal `anonymous`, que es lo que de verdad se sabe', () => {
    const request: FakeRequest = { headers: {} }
    const { context } = contextFor(request)

    expect(new AnonymousIdentityGuard().canActivate(context)).toBe(true)
    expect(request.identity).toBe(ANONYMOUS_IDENTITY)
    expect(request.identity?.subject).toBe('anonymous')
  })

  it('concede todos los roles: sin identidad no hay forma de distinguirlos', () => {
    expect(ANONYMOUS_IDENTITY.roles.has(Role.Administrator)).toBe(true)
    expect(ANONYMOUS_IDENTITY.roles.has(Role.Moderator)).toBe(true)
    expect(ANONYMOUS_IDENTITY.roles.has(Role.Player)).toBe(true)
  })
})

describe('Configuracion de autenticacion', () => {
  it('desactiva la autenticacion por defecto, que es el estado del BLOCKER', () => {
    const config = loadConfig({})

    expect(config.authMode).toBe(AuthMode.Disabled)
    expect(config.cognito).toBeNull()
  })

  /**
   * La comprobacion mas importante del fichero: un binario de produccion sin
   * verificacion de identidad NO ARRANCA. Un aviso en el registro se pasa por
   * alto; un arranque que falla, no.
   */
  it('impide arrancar en produccion sin verificacion de identidad', () => {
    expect(() => loadConfig({ NODE_ENV: 'production', AUTH_MODE: 'disabled' })).toThrow(
      ConfigurationError,
    )
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(ConfigurationError)
  })

  it('exige el pool y el cliente cuando la autenticacion esta activa', () => {
    expect(() => loadConfig({ AUTH_MODE: 'jwt' })).toThrow(ConfigurationError)
    expect(() => loadConfig({ AUTH_MODE: 'jwt', COGNITO_USER_POOL_ID: 'p' })).toThrow(
      ConfigurationError,
    )
  })

  it('acepta produccion cuando la autenticacion esta completa', () => {
    const config = loadConfig({
      NODE_ENV: 'production',
      AUTH_MODE: 'jwt',
      COGNITO_USER_POOL_ID: 'us-east-1_abc',
      COGNITO_CLIENT_ID: 'cliente',
    })

    expect(config.cognito).toEqual({ userPoolId: 'us-east-1_abc', clientId: 'cliente' })
  })
})
