export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigurationError'
  }
}

export const AuthMode = {
  /**
   * Sin verificacion de identidad. Es el estado que describe el BLOCKER de
   * ADR-004, no una opcion de conveniencia: ningun servicio comprueba quien
   * realiza la peticion.
   */
  Disabled: 'disabled',
  /** Se exige un testimonio firmado por el proveedor de identidad. */
  Jwt: 'jwt',
} as const

export type AuthMode = (typeof AuthMode)[keyof typeof AuthMode]

export interface CognitoConfig {
  readonly userPoolId: string
  readonly clientId: string
}

export const PersistenceDriver = {
  Memory: 'memory',
  Postgres: 'postgres',
} as const

export type PersistenceDriver = (typeof PersistenceDriver)[keyof typeof PersistenceDriver]

export interface AppConfig {
  readonly nodeEnv: 'development' | 'test' | 'production'
  readonly serviceName: string
  readonly version: string
  readonly logLevel: 'debug' | 'info' | 'warn' | 'error'
  readonly port: number
  readonly globalPrefix: string
  readonly swaggerEnabled: boolean
  readonly persistenceDriver: PersistenceDriver
  readonly databaseUrl: string | null
  readonly authMode: AuthMode
  readonly cognito: CognitoConfig | null
  /** Contrato interno con Catalog para descontar unidades (HU-34). */
  readonly catalogInternalUrl: string | null
  readonly internalServiceAuthSecret: string | null
  readonly internalServiceName: string
  readonly internalTimeoutMs: number
  readonly integrationMode: 'http' | 'local'
  readonly inventoryInternalUrl: string | null
  readonly notificationsInternalUrl: string | null
  readonly accountUrl: string | null
}

type RawEnv = Readonly<Record<string, string | undefined>>

const readEnum = <T extends string>(
  env: RawEnv,
  key: string,
  allowed: readonly T[],
  fallback: T,
): T => {
  const raw = env[key]

  if (raw === undefined || raw === '') {
    return fallback
  }

  if (!(allowed as readonly string[]).includes(raw)) {
    throw new ConfigurationError(
      `${key} debe ser uno de: ${allowed.join(', ')}. Se recibio "${raw}".`,
    )
  }

  return raw as T
}

const readInteger = (
  env: RawEnv,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number => {
  const raw = env[key]

  if (raw === undefined || raw === '') {
    return fallback
  }

  const parsed = Number(raw)

  if (!Number.isInteger(parsed)) {
    throw new ConfigurationError(`${key} debe ser un numero entero. Se recibio "${raw}".`)
  }

  if (parsed < min || parsed > max) {
    throw new ConfigurationError(
      `${key} debe estar entre ${String(min)} y ${String(max)}. Se recibio ${String(parsed)}.`,
    )
  }

  return parsed
}

const readString = (env: RawEnv, key: string, fallback: string): string => {
  const raw = env[key]

  return raw === undefined || raw === '' ? fallback : raw
}

const readBoolean = (env: RawEnv, key: string, fallback: boolean): boolean => {
  const raw = env[key]

  if (raw === undefined || raw === '') {
    return fallback
  }

  if (raw !== 'true' && raw !== 'false') {
    throw new ConfigurationError(`${key} debe ser "true" o "false". Se recibio "${raw}".`)
  }

  return raw === 'true'
}

/**
 * Construye la configuracion a partir del entorno. Es una funcion pura sobre
 * `env`: no lee `process.env` directamente, de modo que puede verificarse por
 * completo sin contaminar el proceso de pruebas.
 *
 * Falla de inmediato ante una configuracion invalida. Un servicio mal
 * configurado no debe arrancar y aparentar salud.
 */
export const loadConfig = (env: RawEnv): AppConfig => {
  const nodeEnv = readEnum(
    env,
    'NODE_ENV',
    ['development', 'test', 'production'] as const,
    'development',
  )

  const persistenceDriver = readEnum(
    env,
    'PERSISTENCE_DRIVER',
    [PersistenceDriver.Memory, PersistenceDriver.Postgres],
    PersistenceDriver.Memory,
  )

  const databaseUrl = env.DATABASE_URL ?? null

  if (
    persistenceDriver === PersistenceDriver.Postgres &&
    (databaseUrl === null || databaseUrl === '')
  ) {
    throw new ConfigurationError(
      'DATABASE_URL es obligatorio cuando PERSISTENCE_DRIVER es "postgres".',
    )
  }

  const authMode = readEnum(env, 'AUTH_MODE', [AuthMode.Disabled, AuthMode.Jwt], AuthMode.Disabled)

  // Un binario de produccion sin verificacion de identidad no arranca.
  //
  // Es la traduccion en codigo del BLOCKER de ADR-004: mientras ningun servicio
  // compruebe quien realiza la peticion, cualquiera puede actuar en nombre de
  // otra persona. Un aviso en el registro se pasa por alto; un arranque que
  // falla, no.
  if (nodeEnv === 'production' && authMode === AuthMode.Disabled) {
    throw new ConfigurationError(
      'AUTH_MODE no puede ser "disabled" con NODE_ENV=production. Sin verificacion de ' +
        'identidad el servicio no debe exponerse. Vease ADR-004.',
    )
  }

  const catalogInternalUrl = readString(env, 'CATALOG_INTERNAL_URL', '')
  const internalServiceAuthSecret = readString(env, 'INTERNAL_SERVICE_AUTH_SECRET', '')

  // Sin el contrato interno, la compra NO descuenta del catalogo: se venderian
  // unidades de un tiraje limitado sin que nadie lo notara, y el tiraje
  // configurado dejaria de significar lo que dice.
  //
  // Es la misma forma que la guardia de arriba y por la misma razon: un aviso
  // en el registro se pasa por alto; un arranque que falla, no. En desarrollo
  // se permite ausente, y entonces el servicio arranca con el descuento
  // desactivado y lo dice en el registro.
  if (nodeEnv === 'production' && (catalogInternalUrl === '' || internalServiceAuthSecret === '')) {
    throw new ConfigurationError(
      'CATALOG_INTERNAL_URL e INTERNAL_SERVICE_AUTH_SECRET son obligatorios con ' +
        'NODE_ENV=production. Sin ellos la compra no descuenta unidades del catalogo ' +
        'y el tiraje limitado deja de aplicarse. Vease HU-34.',
    )
  }

  const integrationMode = readEnum(
    env,
    'COMMERCE_INTEGRATION_MODE',
    ['http', 'local'] as const,
    nodeEnv === 'production' ? 'http' : 'local',
  )
  const inventoryInternalUrl = readString(env, 'INVENTORY_INTERNAL_URL', '')
  const notificationsInternalUrl = readString(env, 'NOTIFICATIONS_INTERNAL_URL', '')
  const accountUrl = readString(env, 'ACCOUNT_URL', '')
  if (nodeEnv === 'production' && integrationMode !== 'http')
    throw new ConfigurationError(
      'Produccion exige COMMERCE_INTEGRATION_MODE=http; los adaptadores locales son solo para desarrollo.',
    )
  if (integrationMode === 'http') {
    if (persistenceDriver !== PersistenceDriver.Postgres)
      throw new ConfigurationError(
        'La integracion HTTP exige PERSISTENCE_DRIVER=postgres para recuperar compras interrumpidas.',
      )
    for (const [key, value] of Object.entries({
      CATALOG_INTERNAL_URL: catalogInternalUrl,
      INVENTORY_INTERNAL_URL: inventoryInternalUrl,
      NOTIFICATIONS_INTERNAL_URL: notificationsInternalUrl,
      ACCOUNT_URL: accountUrl,
    })) {
      if (value === '')
        throw new ConfigurationError(key + ' es obligatorio con COMMERCE_INTEGRATION_MODE=http.')
      let url: URL
      try {
        url = new URL(value)
      } catch {
        throw new ConfigurationError(key + ' debe ser una URL absoluta.')
      }
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.pathname !== '/'
      )
        throw new ConfigurationError(
          key + ' debe ser un origen HTTP(S), sin credenciales, ruta o parametros.',
        )
    }
    if (internalServiceAuthSecret === '')
      throw new ConfigurationError(
        'INTERNAL_SERVICE_AUTH_SECRET es obligatorio con COMMERCE_INTEGRATION_MODE=http.',
      )
  }

  const cognitoUserPoolId = readString(env, 'COGNITO_USER_POOL_ID', '')
  const cognitoClientId = readString(env, 'COGNITO_CLIENT_ID', '')

  if (authMode === AuthMode.Jwt && (cognitoUserPoolId === '' || cognitoClientId === '')) {
    throw new ConfigurationError(
      'COGNITO_USER_POOL_ID y COGNITO_CLIENT_ID son obligatorios cuando AUTH_MODE es "jwt".',
    )
  }

  return {
    nodeEnv,
    integrationMode,
    inventoryInternalUrl: inventoryInternalUrl || null,
    notificationsInternalUrl: notificationsInternalUrl || null,
    accountUrl: accountUrl || null,
    serviceName: readString(env, 'SERVICE_NAME', 'nexus-battle-commerce'),
    version: readString(env, 'SERVICE_VERSION', '0.1.0'),
    logLevel: readEnum(env, 'LOG_LEVEL', ['debug', 'info', 'warn', 'error'] as const, 'info'),
    port: readInteger(env, 'PORT', 3005, 1, 65_535),
    globalPrefix: readString(env, 'GLOBAL_PREFIX', 'api'),
    // La documentacion interactiva permanece deshabilitada en produccion salvo
    // decision explicita: expone la superficie completa de la API.
    swaggerEnabled: readBoolean(env, 'SWAGGER_ENABLED', nodeEnv !== 'production'),
    persistenceDriver,
    databaseUrl: databaseUrl === '' ? null : databaseUrl,
    authMode,
    catalogInternalUrl: catalogInternalUrl === '' ? null : catalogInternalUrl,
    internalServiceAuthSecret: internalServiceAuthSecret === '' ? null : internalServiceAuthSecret,
    internalServiceName: readString(env, 'INTERNAL_SERVICE_NAME', 'commerce'),
    internalTimeoutMs: readInteger(env, 'INTERNAL_TIMEOUT_MS', 2_000, 100, 30_000),
    cognito:
      authMode === AuthMode.Jwt
        ? { userPoolId: cognitoUserPoolId, clientId: cognitoClientId }
        : null,
  }
}
