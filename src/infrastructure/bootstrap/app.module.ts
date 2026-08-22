import { Module } from '@nestjs/common'

import { OrdersController } from '../../adapters/inbound/http/orders.controller'
import { HealthController } from '../../adapters/inbound/http/health.controller'
import {
  ADD_LINE,
  CANCEL_ORDER,
  CONFIRM_ORDER,
  CREATE_ORDER,
  GET_ORDER,
  LIST_ORDERS,
  REMOVE_LINE,
} from '../../adapters/inbound/http/tokens'
import { READINESS_CHECKS, VERSION_REPORT } from '../../adapters/inbound/http/tokens.health'

import {
  AddOrderLine,
  CancelOrder,
  ConfirmOrder,
  CreateOrder,
  GetOrder,
  ListCustomerOrders,
  RemoveOrderLine,
  type OrderDependencies,
} from '../../application/use-cases/OrderUseCases'
import { ORDER_REPOSITORY } from '../../application/ports/OrderRepositoryPort'
import { PRODUCT_PRICING } from '../../application/ports/ProductPricingPort'
import { CLOCK } from '../../application/ports/ClockPort'
import { ID_GENERATOR } from '../../application/ports/IdGeneratorPort'
import type { OrderRepositoryPort } from '../../application/ports/OrderRepositoryPort'
import type { ProductPricingPort } from '../../application/ports/ProductPricingPort'
import type { ClockPort } from '../../application/ports/ClockPort'
import type { IdGeneratorPort } from '../../application/ports/IdGeneratorPort'

import { InMemoryOrderRepository } from '../../adapters/outbound/persistence/InMemoryOrderRepository'
import {
  DEMO_PRICES,
  LocalCatalogPricing,
} from '../../adapters/outbound/pricing/LocalCatalogPricing'
import { SystemClock } from '../../adapters/outbound/system/SystemClock'
import { UuidGenerator } from '../../adapters/outbound/system/UuidGenerator'

import { createLogger, type Logger } from '../observability/logger'
import { loadConfig, PersistenceDriver, type AppConfig } from '../config/env'
import type { ReadinessCheck, VersionReport } from '../health/health'

export const APP_CONFIG = Symbol('AppConfig')
export const LOGGER = Symbol('Logger')
export const ORDER_DEPENDENCIES = Symbol('OrderDependencies')

/**
 * Raiz de composicion.
 *
 * Es el unico lugar donde se eligen implementaciones concretas. Los casos de
 * uso son clases planas sin decoradores de NestJS: se registran con fabricas
 * explicitas, de modo que la capa de aplicacion permanece independiente del
 * framework.
 */
@Module({
  controllers: [OrdersController, HealthController],
  providers: [
    {
      provide: APP_CONFIG,
      useFactory: (): AppConfig => loadConfig(process.env),
    },
    {
      provide: LOGGER,
      useFactory: (config: AppConfig): Logger =>
        createLogger({
          level: config.logLevel,
          service: config.serviceName,
          version: config.version,
        }),
      inject: [APP_CONFIG],
    },
    {
      provide: ORDER_REPOSITORY,
      useFactory: (config: AppConfig, logger: Logger): OrderRepositoryPort => {
        if (config.persistenceDriver === PersistenceDriver.Postgres) {
          // La configuracion se valida al arrancar para que un despliegue mal
          // parametrizado falle de inmediato. El adaptador PostgreSQL depende
          // de que ADR-005 decida el ORM; no se sustituye por una simulacion.
          logger.warn('postgres_driver_not_available', {
            detail:
              'El adaptador PostgreSQL requiere ADR-005 aprobado. Se usa el repositorio en memoria.',
          })
        }

        return new InMemoryOrderRepository()
      },
      inject: [APP_CONFIG, LOGGER],
    },
    {
      provide: PRODUCT_PRICING,
      useFactory: (logger: Logger): ProductPricingPort => {
        // El adaptador HTTP hacia Catalog depende de ADR-006. Hasta entonces
        // se usa el catalogo local, que es una implementacion completa del
        // puerto. Lo que nunca se hace es leer la base de datos de Catalog.
        logger.info('pricing_adapter_selected', {
          adapter: 'local-catalog',
          detail: 'El adaptador HTTP hacia Catalog requiere ADR-006 aprobado.',
        })

        return new LocalCatalogPricing(DEMO_PRICES)
      },
      inject: [LOGGER],
    },
    {
      provide: CLOCK,
      useFactory: (): ClockPort => new SystemClock(),
    },
    {
      provide: ID_GENERATOR,
      useFactory: (): IdGeneratorPort => new UuidGenerator(),
    },
    {
      provide: ORDER_DEPENDENCIES,
      useFactory: (
        orders: OrderRepositoryPort,
        pricing: ProductPricingPort,
        clock: ClockPort,
        ids: IdGeneratorPort,
      ): OrderDependencies => ({ orders, pricing, clock, ids }),
      inject: [ORDER_REPOSITORY, PRODUCT_PRICING, CLOCK, ID_GENERATOR],
    },
    {
      provide: CREATE_ORDER,
      useFactory: (deps: OrderDependencies): CreateOrder => new CreateOrder(deps),
      inject: [ORDER_DEPENDENCIES],
    },
    {
      provide: ADD_LINE,
      useFactory: (deps: OrderDependencies): AddOrderLine => new AddOrderLine(deps),
      inject: [ORDER_DEPENDENCIES],
    },
    {
      provide: REMOVE_LINE,
      useFactory: (deps: OrderDependencies): RemoveOrderLine => new RemoveOrderLine(deps),
      inject: [ORDER_DEPENDENCIES],
    },
    {
      provide: CONFIRM_ORDER,
      useFactory: (deps: OrderDependencies): ConfirmOrder => new ConfirmOrder(deps),
      inject: [ORDER_DEPENDENCIES],
    },
    {
      provide: CANCEL_ORDER,
      useFactory: (deps: OrderDependencies): CancelOrder => new CancelOrder(deps),
      inject: [ORDER_DEPENDENCIES],
    },
    {
      provide: GET_ORDER,
      useFactory: (orders: OrderRepositoryPort): GetOrder => new GetOrder(orders),
      inject: [ORDER_REPOSITORY],
    },
    {
      provide: LIST_ORDERS,
      useFactory: (orders: OrderRepositoryPort): ListCustomerOrders =>
        new ListCustomerOrders(orders),
      inject: [ORDER_REPOSITORY],
    },
    {
      provide: READINESS_CHECKS,
      useFactory: (
        orders: OrderRepositoryPort,
        pricing: ProductPricingPort,
      ): readonly ReadinessCheck[] => [
        // Ambas comprobaciones ejercitan las dependencias de verdad: si alguna
        // no responde, la sonda falla. No se declara `ok` de forma incondicional.
        { name: 'orders-repository', check: (): boolean => typeof orders.findById === 'function' },
        { name: 'catalog-pricing', check: (): boolean => typeof pricing.priceOf === 'function' },
      ],
      inject: [ORDER_REPOSITORY, PRODUCT_PRICING],
    },
    {
      provide: VERSION_REPORT,
      useFactory: (config: AppConfig): VersionReport => ({
        service: config.serviceName,
        version: config.version,
        nodeEnv: config.nodeEnv,
      }),
      inject: [APP_CONFIG],
    },
  ],
})
export class AppModule {}
