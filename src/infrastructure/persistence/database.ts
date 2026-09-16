import {
  Kysely,
  Migrator,
  PostgresDialect,
  type MigrationProvider,
  type MigrationResult,
} from 'kysely'
import { Pool } from 'pg'

import type { Database } from '../../adapters/outbound/persistence/schema'
import * as migration001 from '../../adapters/outbound/persistence/migrations/001-orders'
import * as migration002 from '../../adapters/outbound/persistence/migrations/002-wishlist'
import * as migration004 from '../../adapters/outbound/persistence/migrations/004-integrated-purchases'
import * as migration003 from '../../adapters/outbound/persistence/migrations/003-saved-cart'
import * as migration005 from '../../adapters/outbound/persistence/migrations/005-purchase-premium-notices'

export interface DatabaseOptions {
  readonly connectionString: string
  /**
   * Conexiones simultaneas del pool.
   *
   * Deliberadamente bajo. Los seis servicios y los dos motores comparten
   * instancia (ADR-011): si cada servicio abriera un pool generoso, PostgreSQL
   * agotaria `max_connections` antes de que ningun servicio notara presion.
   */
  readonly maxConnections?: number
  /**
   * Recibe los errores de las conexiones OCIOSAS del pool.
   *
   * Una conexion que espera en el pool sigue unida a un proceso del motor. Si
   * el motor se reinicia o la red se corta, esa conexion emite `error` en el
   * pool, y sin ningun oyente Node trata el evento como no controlado y
   * TERMINA EL PROCESO. El servicio entero caeria por un reinicio de la base,
   * en lugar de responder 503 en la readiness y recuperarse solo.
   *
   * Se descubrio en Nexus-Battle-Wallet con la prueba de control de la CI: al
   * parar PostgreSQL, el contenedor dejaba de responder en vez de devolver 503.
   */
  readonly onIdleError?: (error: Error) => void
}

export const createDatabase = (options: DatabaseOptions): Kysely<Database> => {
  const pool = new Pool({
    connectionString: options.connectionString,
    max: options.maxConnections ?? 5,
    // Cerrar conexiones ociosas devuelve capacidad al motor compartido.
    idleTimeoutMillis: 30_000,
    // Sin este limite, un motor caido deja las peticiones colgadas hasta el
    // tiempo de espera de la peticion HTTP, que es mucho mas largo.
    connectionTimeoutMillis: 5_000,
  })

  // El oyente se registra SIEMPRE, aunque nadie pase `onIdleError`: su mera
  // presencia es lo que impide que el proceso termine. El pool ya descarta la
  // conexion rota y abre otra en la siguiente consulta.
  pool.on('error', (error: Error) => {
    options.onIdleError?.(error)
  })

  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) })
}

/**
 * Migraciones declaradas en codigo, no descubiertas del sistema de ficheros.
 *
 * `FileMigrationProvider` leeria el directorio en tiempo de ejecucion, y en la
 * imagen de produccion ese directorio contiene JavaScript compilado con otra
 * ruta. Importarlas explicitamente hace que el compilador las verifique y que
 * el empaquetado no pueda dejarse ninguna fuera en silencio.
 */
const migrations: MigrationProvider = {
  getMigrations: () =>
    Promise.resolve({
      '001-orders': migration001,
      '002-wishlist': migration002,
      '003-saved-cart': migration003,
      '004-integrated-purchases': migration004,
      '005-purchase-premium-notices': migration005,
    }),
}

export interface MigrationOutcome {
  readonly applied: readonly string[]
  readonly error: unknown
}

/**
 * Lleva el esquema al ultimo estado conocido.
 *
 * No se ejecuta al arrancar el servicio: migrar desde el arranque significa que
 * varias replicas migran a la vez, y que un despliegue con una migracion rota
 * deja el servicio en bucle de reinicio. Se invoca desde `npm run migrate`,
 * como paso explicito del despliegue.
 */
export const migrateToLatest = async (db: Kysely<Database>): Promise<MigrationOutcome> => {
  const migrator = new Migrator({ db, provider: migrations })
  const { error, results } = await migrator.migrateToLatest()

  return {
    applied: (results ?? [])
      .filter((result: MigrationResult) => result.status === 'Success')
      .map((result: MigrationResult) => result.migrationName),
    error,
  }
}
