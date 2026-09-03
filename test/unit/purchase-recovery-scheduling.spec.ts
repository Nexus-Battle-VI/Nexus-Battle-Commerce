import { InMemoryPurchaseStore } from '../../src/adapters/outbound/persistence/InMemoryPurchaseStore'
import { InMemoryOrderRepository } from '../../src/adapters/outbound/persistence/InMemoryOrderRepository'
import { recoveryContract, type RecoveryFixture } from '../support/recovery-contract'

describe('Reprogramacion de compras en memoria', () => {
  let fixture: RecoveryFixture
  beforeEach(() => {
    const orders = new InMemoryOrderRepository()
    fixture = { orders, store: new InMemoryPurchaseStore(orders) }
  })
  recoveryContract(() => fixture)
})
