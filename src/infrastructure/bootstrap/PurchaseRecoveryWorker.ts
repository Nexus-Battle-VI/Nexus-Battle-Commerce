import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import type { IntegratedCheckout } from '../../application/use-cases/IntegratedCheckout'
import type { Logger } from '../observability/logger'

/** Retries durable attempts and outbox entries; no request credentials survive a restart. */
export class PurchaseRecoveryWorker implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | undefined
  private running = false
  constructor(
    private readonly checkout: IntegratedCheckout | null,
    private readonly logger: Logger,
  ) {}
  onModuleInit(): void {
    if (this.checkout === null) return
    this.timer = setInterval(() => {
      void this.tick()
    }, 2000)
    this.timer.unref()
  }
  async tick(): Promise<void> {
    if (this.running || this.checkout === null) return
    this.running = true
    try {
      await this.checkout.recover()
    } catch {
      this.logger.error('purchase_recovery_failed', {
        detail: 'La compra permanece registrada; se reintentara en el siguiente ciclo.',
      })
    } finally {
      this.running = false
    }
  }
  onModuleDestroy(): void {
    if (this.timer !== undefined) clearInterval(this.timer)
  }
}
