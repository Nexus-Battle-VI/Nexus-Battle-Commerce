import { sql, type Kysely } from 'kysely'
import { startTestPostgres, type TestPostgres } from './postgres-runtime'
import { createDatabase, migrateToLatest } from '../../src/infrastructure/persistence/database'
import type { Database } from '../../src/adapters/outbound/persistence/schema'
import { PostgresPurchaseStore } from '../../src/adapters/outbound/persistence/PostgresPurchaseStore'
import { PostgresOrderRepository } from '../../src/adapters/outbound/persistence/PostgresOrderRepository'
import { down } from '../../src/adapters/outbound/persistence/migrations/004-integrated-purchases'
import { recoveryContract, seedAttempt, type RecoveryFixture } from '../support/recovery-contract'

describe('Reprogramacion durable PostgreSQL', () => {
  let server: TestPostgres
  let db: Kysely<Database>
  let fixture: RecoveryFixture
  beforeAll(async () => {
    server = await startTestPostgres()
    db = createDatabase({ connectionString: server.getConnectionUri() })
    const migration = await migrateToLatest(db)
    if (migration.error !== undefined)
      throw migration.error instanceof Error
        ? migration.error
        : new Error('Fallo al preparar la migracion', { cause: migration.error })
  })
  afterAll(async () => {
    await db.destroy()
    await server.stop()
  })
  beforeEach(async () => {
    await sql`truncate purchase_mail_outbox, purchase_attempts, order_lines, orders`.execute(db)
    fixture = { orders: new PostgresOrderRepository(db), store: new PostgresPurchaseStore(db) }
  })
  recoveryContract(() => fixture)

  it('rechaza rollback sin borrar historial, outbox ni referencias UUID', async () => {
    const attempt = await seedAttempt(fixture, 0)
    await fixture.store.advance(attempt.id, 'RESERVING', 'RESERVED')
    await fixture.store.advance(attempt.id, 'RESERVED', 'DELIVERED')
    await fixture.store.complete(attempt)
    const before = await db.selectFrom('purchase_attempts').selectAll().execute()
    const mail = await db.selectFrom('purchase_mail_outbox').selectAll().execute()
    const lines = await db.selectFrom('order_lines').selectAll().execute()
    await expect(down()).rejects.toThrow('solo admite avance')
    expect(await db.selectFrom('purchase_attempts').selectAll().execute()).toEqual(before)
    expect(await db.selectFrom('purchase_mail_outbox').selectAll().execute()).toEqual(mail)
    expect(await db.selectFrom('order_lines').selectAll().execute()).toEqual(lines)
  })

  it('persiste la fecha tras reinicio, conserva created_at y no revive terminales', async () => {
    const attempt = await seedAttempt(fixture, 0)
    const future = new Date(Date.now() + 60_000)
    const original = await db
      .selectFrom('purchase_attempts')
      .selectAll()
      .where('id', '=', attempt.id)
      .executeTakeFirstOrThrow()
    await fixture.store.deferAttempt(attempt.id, future)
    const restarted = new PostgresPurchaseStore(db)
    expect(await restarted.pending()).toHaveLength(1)
    expect(await restarted.dueAttempts(new Date())).toEqual([])
    expect(await restarted.dueAttempts(future)).toHaveLength(1)
    const deferred = await db
      .selectFrom('purchase_attempts')
      .selectAll()
      .where('id', '=', attempt.id)
      .executeTakeFirstOrThrow()
    expect(deferred.updated_at).toEqual(original.updated_at)
    expect(deferred.payload).toEqual(original.payload)
    await restarted.advance(attempt.id, 'RESERVING', 'RESERVED')
    await restarted.advance(attempt.id, 'RESERVED', 'DELIVERED')
    await restarted.complete(attempt)
    const originalMail = await db
      .selectFrom('purchase_mail_outbox')
      .selectAll()
      .where('id', '=', attempt.id)
      .executeTakeFirstOrThrow()
    await restarted.deferMail(attempt.id, future)
    const mail = await db
      .selectFrom('purchase_mail_outbox')
      .selectAll()
      .where('id', '=', attempt.id)
      .executeTakeFirstOrThrow()
    expect(mail.created_at).toEqual(originalMail.created_at)
    expect(mail.payload).toEqual(originalMail.payload)
    expect(await new PostgresPurchaseStore(db).dueMail(new Date())).toEqual([])
    expect(await restarted.dueMail(future)).toHaveLength(1)
    await restarted.markMailSent(attempt.id)
    await restarted.deferMail(attempt.id, new Date())
    await restarted.deferAttempt(attempt.id, new Date())
    expect(await restarted.dueAttempts(future)).toEqual([])
    expect(await restarted.dueMail(future)).toEqual([])
    const rejected = await seedAttempt(fixture, 1)
    await restarted.fail(rejected, 'Rechazo definitivo')
    await restarted.deferAttempt(rejected.id, future)
    expect(await restarted.pending()).toEqual([])
    const failed = await db
      .selectFrom('purchase_attempts')
      .selectAll()
      .where('id', '=', rejected.id)
      .executeTakeFirstOrThrow()
    expect(failed.next_attempt_at.getTime()).toBeLessThan(future.getTime())
  })
})
