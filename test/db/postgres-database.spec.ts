import { startTestPostgres, type TestPostgres } from './postgres-runtime'
import { sql, type Kysely } from 'kysely'

import type { Database } from '../../src/adapters/outbound/persistence/schema'
import { createDatabase } from '../../src/infrastructure/persistence/database'

/**
 * El pool de PostgreSQL contra un motor REAL.
 *
 * Lo que se prueba no se puede simular con un doble: que el motor corte una
 * conexion que espera ociosa en el pool y que el proceso siga vivo. Sin oyente
 * de `error` en el pool, Node termina el proceso; aqui Jest lo reporta como
 * "Unhandled error" y la prueba falla.
 */
describe('Pool de PostgreSQL', () => {
  let container: TestPostgres
  let db: Kysely<Database>

  beforeAll(async () => {
    container = await startTestPostgres()
    db = createDatabase({ connectionString: container.getConnectionUri() })
  }, 120_000)

  afterAll(async () => {
    await db.destroy()
    await container.stop()
  })

  it('sobrevive a que el motor corte una conexion ociosa del pool', async () => {
    const errores: Error[] = []
    // Un nombre de aplicacion propio para cortar SOLO la conexion de este pool.
    const aplicacion = 'prueba-conexion-ociosa'
    const url = new URL(container.getConnectionUri())
    url.searchParams.set('application_name', aplicacion)
    const propia = createDatabase({
      connectionString: url.toString(),
      onIdleError: (error) => errores.push(error),
    })

    try {
      await sql`select 1`.execute(propia)

      const cortadas = await sql<{ cortada: boolean }>`
        select pg_terminate_backend(pid) as cortada from pg_stat_activity
        where application_name = ${aplicacion} and state = 'idle'
      `.execute(db)

      // Control: si no se hubiera cortado ninguna conexion, la prueba pasaria
      // sin haber ejercitado nada.
      expect(cortadas.rows).toEqual([{ cortada: true }])

      for (let intento = 0; intento < 50 && errores.length === 0; intento += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100))
      }

      expect(errores.length).toBeGreaterThan(0)

      // El pool descarto la conexion rota: la siguiente consulta abre otra.
      const { rows } = await sql<{ uno: number }>`select 1 as uno`.execute(propia)
      expect(rows).toEqual([{ uno: 1 }])
    } finally {
      await propia.destroy()
    }
  })
})
