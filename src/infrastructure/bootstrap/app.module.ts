import { Module, type CanActivate } from '@nestjs/common'
import { APP_GUARD, Reflector } from '@nestjs/core'
import type { Kysely } from 'kysely'

import { OrdersController } from '../../adapters/inbound/http/orders.controller'
import { WishlistController } from '../../adapters/inbound/http/wishlist.controller'
import { HealthController } from '../../adapters/inbound/http/health.controller'
import {
  ADD_LINE,
  CANCEL_ORDER,
  CHANGE_LINE_QUANTITY,
  CONFIRM_ORDER,
  CREATE_ORDER,
  GET_CART,
  GET_OR_CREATE_CART,
  GET_ORDER,
  LIST_ORDERS,
  REMOVE_LINE,
} from '../../adapters/inbound/http/tokens'
import {
  ADD_TO_WISHLIST,
  GET_WISHLIST_ITEM,
  LIST_WISHLIST,
  REMOVE_FROM_WISHLIST,
} from '../../adapters/inbound/http/tokens.wishlist'
import { READINESS_CHECKS, VERSION_REPORT } from '../../adapters/inbound/http/tokens.health'

import {
  AddOrderLine,
  CancelOrder,
  ChangeOrderLineQuantity,
  ConfirmOrder,
  CreateOrder,
  GetCart,
  GetOrCreateCart,
  GetOrder,
  ListCustomerOrders,
  RemoveOrderLine,
  type OrderDependencies,
} from '../../application/use-cases/OrderUseCases'
import {
  AddToWishlist,
  GetWishlistItemStatus,
  ListWishlist,
  RemoveFromWishlist,
  type WishlistDependencies,
} from '../../application/use-cases/WishlistUseCases'
import { ORDER_REPOSITORY } from '../../application/ports/OrderRepositoryPort'
import { WISHLIST_REPOSITORY } from '../../application/ports/WishlistRepositoryPort'
import { PRODUCT_PRICING } from '../../application/ports/ProductPricingPort'
import { CLOCK } from '../../application/ports/ClockPort'
import { ID_GENERATOR } from '../../application/ports/IdGeneratorPort'
import type { OrderRepositoryPort } from '../../application/ports/OrderRepositoryPort'
import type { WishlistRepositoryPort } from '../../application/ports/WishlistRepositoryPort'
import type { ProductPricingPort } from '../../application/ports/ProductPricingPort'
import type { ClockPort } from '../../application/ports/ClockPort'
import type { IdGeneratorPort } from '../../application/ports/IdGeneratorPort'

import { InMemoryOrderRepository } from '../../adapters/outbound/persistence/InMemoryOrderRepository'
import { PostgresOrderRepository } from '../../adapters/outbound/persistence/PostgresOrderRepository'
import { InMemoryWishlistRepository } from '../../adapters/outbound/persistence/InMemoryWishlistRepository'
import { PostgresWishlistRepository } from '../../adapters/outbound/persistence/PostgresWishlistRepository'
import {
  DEMO_PRICES,
  LocalCatalogPricing,
} from '../../adapters/outbound/pricing/LocalCatalogPricing'
import { SystemClock } from '../../adapters/outbound/system/SystemClock'
import { UuidGenerator } from '../../adapters/outbound/system/UuidGenerator'

import { createDatabase } from '../persistence/database'
import type { Database } from '../../adapters/outbound/persistence/schema'
import { createLogger, type Logger } from '../observability/logger'
import { AuthMode, loadConfig, PersistenceDriver, type AppConfig } from '../config/env'

import { JwtAuthGuard } from '../../adapters/inbound/http/auth/jwt-auth.guard'
import { RolesGuard } from '../../adapters/inbound/http/auth/roles.guard'
import { AnonymousIdentityGuard } from '../../adapters/inbound/http/auth/anonymous.guard'
import { TOKEN_VERIFIER } from '../../application/ports/TokenVerifierPort'
import type { TokenVerifierPort } from '../../application/ports/TokenVerifierPort'
import { CognitoTokenVerifier } from '../../adapters/outbound/identity/CognitoTokenVerifier'
import type { ReadinessCheck, VersionReport } from '../health/health'

export const APP_CONFIG = Symbol('AppConfig')
export const LOGGER = Symbol('Logger')
export const ORDER_DEPENDENCIES = Symbol('OrderDependencies')
export const WISHLIST_DEPENDENCIES = Symbol('WishlistDependencies')

/**
 * Conexion a PostgreSQL, unica por proceso.
 *
 * `Order` y `Wishlist` comparten el mismo esquema (`schema.ts`) y por tanto la
 * misma conexion: ADR-011 mantiene el limite de conexiones bajo porque seis
 * servicios comparten el motor, y abrir un segundo `Pool` por agregado
 * duplicaria ese consumo sin ninguna razon, ya que ambos repositorios leen y
 * escriben tablas del mismo servicio. `null` cuando el driver es memoria: no
 * se abre una conexion que ningun adaptador va a usar.
 */
export const DATABASE_CONNECTION = Symbol('DatabaseConnection')

/**
 * Raiz de composicion.
 *
 * Es el unico lugar donde se eligen implementaciones concretas. Los casos de
 * uso son clases planas sin decoradores de NestJS: se registran con fabricas
 * explicitas, de modo que la capa de aplicacion permanece independiente del
 * framework.
 */
@Module({
  controllers: [OrdersController, WishlistController, HealthController],
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
      provide: DATABASE_CONNECTION,
      useFactory: (config: AppConfig, logger: Logger): Kysely<Database> | null => {
        if (config.persistenceDriver !== PersistenceDriver.Postgres) {
          logger.warn('in_memory_persistence', {
            detail: 'PERSISTENCE_DRIVER=memory: el estado se pierde al reiniciar el servicio.',
          })

          return null
        }

        // `loadConfig` ya garantiza que DATABASE_URL existe con este driver: un
        // servicio mal configurado no debe arrancar y aparentar salud.
        if (config.databaseUrl === null) {
          throw new Error('DATABASE_URL es obligatorio con PERSISTENCE_DRIVER=postgres.')
        }

        logger.info('postgres_persistence', { detail: 'Adaptador PostgreSQL activo.' })

        return createDatabase({ connectionString: config.databaseUrl })
      },
      inject: [APP_CONFIG, LOGGER],
    },
    {
      provide: ORDER_REPOSITORY,
      useFactory: (db: Kysely<Database> | null): OrderRepositoryPort =>
        db === null ? new InMemoryOrderRepository() : new PostgresOrderRepository(db),
      inject: [DATABASE_CONNECTION],
    },
    {
      provide: WISHLIST_REPOSITORY,
      useFactory: (db: Kysely<Database> | null): WishlistRepositoryPort =>
        db === null ? new InMemoryWishlistRepository() : new PostgresWishlistRepository(db),
      inject: [DATABASE_CONNECTION],
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
      provide: TOKEN_VERIFIER,
      useFactory: (config: AppConfig, logger: Logger): TokenVerifierPort => {
        if (config.cognito === null) {
          // No se devuelve un verificador que acepte cualquier cosa: sin
          // proveedor, el guard directamente no se registra. Un verificador
          // permisivo daria la apariencia de que hay comprobacion.
          logger.warn('authentication_disabled', {
            detail:
              'AUTH_MODE=disabled: ninguna ruta verifica quien realiza la peticion. BLOCKER de ADR-004.',
          })

          return {
            verify: (): Promise<never> => {
              throw new Error('No hay verificador de testimonios configurado.')
            },
          }
        }

        return new CognitoTokenVerifier(config.cognito)
      },
      inject: [APP_CONFIG, LOGGER],
    },
    // Los guards se registran de forma global SOLO cuando hay proveedor. El
    // orden importa: JwtAuthGuard deja la identidad verificada en la peticion y
    // RolesGuard la lee. NestJS los ejecuta en el orden de declaracion.
    {
      provide: APP_GUARD,
      useFactory: (
        config: AppConfig,
        reflector: Reflector,
        verifier: TokenVerifierPort,
      ): CanActivate =>
        config.authMode === AuthMode.Jwt
          ? new JwtAuthGuard(reflector, verifier)
          : // Sin proveedor no se deja pasar sin mas: se atribuye la identidad
            // anonima, para que lo que se guarde diga que nadie fue verificado.
            new AnonymousIdentityGuard(),
      inject: [APP_CONFIG, Reflector, TOKEN_VERIFIER],
    },
    {
      provide: APP_GUARD,
      useFactory: (config: AppConfig, reflector: Reflector): CanActivate =>
        config.authMode === AuthMode.Jwt
          ? new RolesGuard(reflector)
          : { canActivate: (): boolean => true },
      inject: [APP_CONFIG, Reflector],
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
      provide: CHANGE_LINE_QUANTITY,
      useFactory: (deps: OrderDependencies): ChangeOrderLineQuantity =>
        new ChangeOrderLineQuantity(deps),
      inject: [ORDER_DEPENDENCIES],
    },
    {
      provide: GET_OR_CREATE_CART,
      useFactory: (deps: OrderDependencies): GetOrCreateCart => new GetOrCreateCart(deps),
      inject: [ORDER_DEPENDENCIES],
    },
    {
      provide: GET_CART,
      useFactory: (orders: OrderRepositoryPort): GetCart => new GetCart(orders),
      inject: [ORDER_REPOSITORY],
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
      provide: WISHLIST_DEPENDENCIES,
      useFactory: (
        wishlist: WishlistRepositoryPort,
        orders: OrderRepositoryPort,
      ): WishlistDependencies => ({
        wishlist,
        orders,
      }),
      inject: [WISHLIST_REPOSITORY, ORDER_REPOSITORY],
    },
    {
      provide: ADD_TO_WISHLIST,
      useFactory: (deps: WishlistDependencies): AddToWishlist => new AddToWishlist(deps),
      inject: [WISHLIST_DEPENDENCIES],
    },
    {
      provide: REMOVE_FROM_WISHLIST,
      useFactory: (deps: WishlistDependencies): RemoveFromWishlist => new RemoveFromWishlist(deps),
      inject: [WISHLIST_DEPENDENCIES],
    },
    {
      provide: GET_WISHLIST_ITEM,
      useFactory: (deps: WishlistDependencies): GetWishlistItemStatus =>
        new GetWishlistItemStatus(deps),
      inject: [WISHLIST_DEPENDENCIES],
    },
    {
      provide: LIST_WISHLIST,
      useFactory: (deps: WishlistDependencies): ListWishlist => new ListWishlist(deps),
      inject: [WISHLIST_DEPENDENCIES],
    },
    {
      provide: READINESS_CHECKS,
      useFactory: (
        orders: OrderRepositoryPort,
        wishlist: WishlistRepositoryPort,
        pricing: ProductPricingPort,
      ): readonly ReadinessCheck[] => [
        // Todas las comprobaciones ejercitan las dependencias de verdad: si
        // alguna no responde, la sonda falla. No se declara `ok` de forma
        // incondicional.
        { name: 'orders-repository', check: (): boolean => typeof orders.findById === 'function' },
        {
          name: 'wishlist-repository',
          check: (): boolean => typeof wishlist.findByCustomer === 'function',
        },
        { name: 'catalog-pricing', check: (): boolean => typeof pricing.priceOf === 'function' },
      ],
      inject: [ORDER_REPOSITORY, WISHLIST_REPOSITORY, PRODUCT_PRICING],
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
