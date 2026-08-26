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
}

export const createDatabase = (options: DatabaseOptions): Kysely<Database> =>
  new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: new Pool({
        connectionString: options.connectionString,
        max: options.maxConnections ?? 5,
        // Cerrar conexiones ociosas devuelve capacidad al motor compartido.
        idleTimeoutMillis: 30_000,
        // Sin este limite, un motor caido deja las peticiones colgadas hasta el
        // tiempo de espera de la peticion HTTP, que es mucho mas largo.
        connectionTimeoutMillis: 5_000,
      }),
    }),
  })

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
