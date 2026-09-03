import {
  PURCHASE_STORE,
  PURCHASE_RECOVERY,
  type PurchaseStorePort,
} from '../../application/ports/CommerceIntegrationPorts'
import { IntegratedCheckout } from '../../application/use-cases/IntegratedCheckout'
import { PostgresPurchaseStore } from '../../adapters/outbound/persistence/PostgresPurchaseStore'
import { InMemoryPurchaseStore } from '../../adapters/outbound/persistence/InMemoryPurchaseStore'
import { HttpPurchaseRecipient } from '../../adapters/outbound/identity/HttpPurchaseRecipient'
import { HttpCatalogPricing } from '../../adapters/outbound/pricing/HttpCatalogPricing'
import {
  InternalJsonClient,
  HttpCatalogReservations,
  HttpInventoryGrant,
  HttpPurchaseMail,
} from '../../adapters/outbound/inventory/CommerceInternalClients'
import { PurchaseRecoveryWorker } from './PurchaseRecoveryWorker'
const INTEGRATED_CHECKOUT = Symbol('IntegratedCheckout')
const configured = (value: string | null): string => {
  if (value === null) throw new Error('Falta configuracion de integracion.')
  return value
}
import { Module, type CanActivate } from '@nestjs/common'
import { APP_GUARD, Reflector } from '@nestjs/core'
import type { Kysely } from 'kysely'

import { OrdersController } from '../../adapters/inbound/http/orders.controller'
import { WishlistController } from '../../adapters/inbound/http/wishlist.controller'
import { CheckoutController } from '../../adapters/inbound/http/checkout.controller'
import { SavedCartController } from '../../adapters/inbound/http/saved-cart.controller'
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
import { CHECKOUT_ORDER, CHECKOUT_SUMMARY } from '../../adapters/inbound/http/tokens.checkout'
import {
  DISCARD_SAVED_CART,
  GET_SAVED_CART,
  RESTORE_SAVED_CART,
  SAVE_CART,
} from '../../adapters/inbound/http/tokens.saved-cart'
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
import {
  CheckoutOrder,
  GetCheckoutSummary,
  type CheckoutDependencies,
} from '../../application/use-cases/CheckoutUseCases'
import {
  DiscardSavedCart,
  GetSavedCart,
  RestoreSavedCart,
  SaveCart,
  type SavedCartDependencies,
} from '../../application/use-cases/SavedCartUseCases'
import { ORDER_REPOSITORY } from '../../application/ports/OrderRepositoryPort'
import { WISHLIST_REPOSITORY } from '../../application/ports/WishlistRepositoryPort'
import { SAVED_CART_REPOSITORY } from '../../application/ports/SavedCartRepositoryPort'
import type { SavedCartRepositoryPort } from '../../application/ports/SavedCartRepositoryPort'
import { PRODUCT_PRICING } from '../../application/ports/ProductPricingPort'
import { PAYMENT_GATEWAY } from '../../application/ports/PaymentGatewayPort'
import type { PaymentGatewayPort } from '../../application/ports/PaymentGatewayPort'
import { PLAYER_INVENTORY } from '../../application/ports/PlayerInventoryPort'
import {
  CATALOG_INVENTORY,
  type CatalogInventoryPort,
} from '../../application/ports/CatalogInventoryPort'
import { CatalogInventoryClient } from '../../adapters/outbound/inventory/CatalogInventoryClient'
import { EVENT_PUBLISHER } from '../../application/ports/EventPublisherPort'
import type { EventPublisherPort } from '../../application/ports/EventPublisherPort'
import type { PlayerInventoryPort } from '../../application/ports/PlayerInventoryPort'
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
import { InMemorySavedCartRepository } from '../../adapters/outbound/persistence/InMemorySavedCartRepository'
import { PostgresSavedCartRepository } from '../../adapters/outbound/persistence/PostgresSavedCartRepository'
import {
  DEMO_PRICES,
  LocalCatalogPricing,
} from '../../adapters/outbound/pricing/LocalCatalogPricing'
import { SimulatedPaymentGateway } from '../../adapters/outbound/payment/SimulatedPaymentGateway'
import { InMemoryPlayerInventory } from '../../adapters/outbound/inventory/InMemoryPlayerInventory'
import { InMemoryEventPublisher } from '../../adapters/outbound/messaging/InMemoryEventPublisher'
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
export const CHECKOUT_DEPENDENCIES = Symbol('CheckoutDependencies')
export const SAVED_CART_DEPENDENCIES = Symbol('SavedCartDependencies')

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
  controllers: [
    OrdersController,
    WishlistController,
    CheckoutController,
    SavedCartController,
    HealthController,
  ],
  providers: [
    {
      provide: PURCHASE_STORE,
      useFactory: (db: Kysely<Database> | null, orders: OrderRepositoryPort): PurchaseStorePort =>
        db === null ? new InMemoryPurchaseStore(orders) : new PostgresPurchaseStore(db),
      inject: [DATABASE_CONNECTION, ORDER_REPOSITORY],
    },
    {
      provide: INTEGRATED_CHECKOUT,
      useFactory: (
        config: AppConfig,
        orders: OrderRepositoryPort,
        pricing: ProductPricingPort,
        payments: PaymentGatewayPort,
        ids: IdGeneratorPort,
        store: PurchaseStorePort,
      ): IntegratedCheckout | null => {
        if (config.integrationMode !== 'http') return null
        const internal = (url: string | null): InternalJsonClient =>
          new InternalJsonClient(
            configured(url),
            configured(config.internalServiceAuthSecret),
            config.internalTimeoutMs,
          )
        return new IntegratedCheckout({
          orders,
          pricing,
          payments,
          ids,
          store,
          reservations: new HttpCatalogReservations(internal(config.catalogInternalUrl)),
          inventory: new HttpInventoryGrant(internal(config.inventoryInternalUrl)),
          recipient: new HttpPurchaseRecipient(
            configured(config.accountUrl),
            config.internalTimeoutMs,
          ),
          mail: new HttpPurchaseMail(internal(config.notificationsInternalUrl)),
        })
      },
      inject: [
        APP_CONFIG,
        ORDER_REPOSITORY,
        PRODUCT_PRICING,
        PAYMENT_GATEWAY,
        ID_GENERATOR,
        PURCHASE_STORE,
      ],
    },
    {
      provide: PURCHASE_RECOVERY,
      useFactory: (checkout: IntegratedCheckout | null, logger: Logger): PurchaseRecoveryWorker =>
        new PurchaseRecoveryWorker(checkout, logger),
      inject: [INTEGRATED_CHECKOUT, LOGGER],
    },
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
      provide: SAVED_CART_REPOSITORY,
      useFactory: (db: Kysely<Database> | null): SavedCartRepositoryPort =>
        db === null ? new InMemorySavedCartRepository() : new PostgresSavedCartRepository(db),
      inject: [DATABASE_CONNECTION],
    },
    {
      provide: PRODUCT_PRICING,
      useFactory: (config: AppConfig, logger: Logger): ProductPricingPort => {
        logger.info('pricing_adapter_selected', {
          adapter: config.integrationMode === 'http' ? 'catalog-http' : 'local-development',
        })
        return config.integrationMode === 'http'
          ? new HttpCatalogPricing(configured(config.catalogInternalUrl), config.internalTimeoutMs)
          : new LocalCatalogPricing(DEMO_PRICES)
      },
      inject: [APP_CONFIG, LOGGER],
    },
    {
      provide: PAYMENT_GATEWAY,
      useFactory: (logger: Logger): PaymentGatewayPort => {
        // La unica implementacion registrada es la simulada, y eso es lo que
        // HU-59 pide. No hay ninguna ruta por la que este servicio pueda
        // mover dinero real.
        logger.info('payment_gateway_selected', {
          adapter: 'simulated',
          detail: 'HU-59: pasarela academica. No ejecuta movimientos financieros reales.',
        })

        return new SimulatedPaymentGateway()
      },
      inject: [LOGGER],
    },
    {
      provide: PLAYER_INVENTORY,
      useFactory: (logger: Logger): PlayerInventoryPort => {
        // Mismo criterio que el adaptador de precios: la integracion HTTP
        // hacia Player-Inventory necesita un acuerdo entre contextos aprobado.
        logger.info('inventory_adapter_selected', {
          adapter: 'in-memory',
          detail:
            'El adaptador HTTP hacia Player-Inventory requiere un acuerdo de integracion aprobado.',
        })

        return new InMemoryPlayerInventory()
      },
      inject: [LOGGER],
    },
    {
      provide: EVENT_PUBLISHER,
      useFactory: (logger: Logger): EventPublisherPort => {
        // Publicador en proceso. Introducir un broker real exige antes decidir
        // el patron outbox (EN-027.2): publicar despues de guardar puede
        // perder el evento si el broker no responde.
        logger.info('event_publisher_selected', {
          adapter: 'in-memory',
          detail: 'Un broker real requiere decidir antes el patron outbox (EN-027.2).',
        })

        return new InMemoryEventPublisher(logger)
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
        pricing: ProductPricingPort,
        purchases: PurchaseStorePort,
        config: AppConfig,
      ): WishlistDependencies => ({
        wishlist,
        orders,
        ...(config.integrationMode === 'http' ? { pricing, purchases } : {}),
      }),
      inject: [WISHLIST_REPOSITORY, ORDER_REPOSITORY, PRODUCT_PRICING, PURCHASE_STORE, APP_CONFIG],
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
      provide: CATALOG_INVENTORY,
      useFactory: (config: AppConfig, logger: Logger): CatalogInventoryPort | null => {
        if (config.catalogInternalUrl === null || config.internalServiceAuthSecret === null) {
          // `loadConfig` ya impide llegar aqui con NODE_ENV=production, asi que
          // esto solo ocurre en desarrollo. Se dice en voz alta: una compra que
          // no descuenta parece funcionar perfectamente.
          logger.warn('catalog_inventory', {
            driver: 'no-configurado',
            detail:
              'Sin CATALOG_INTERNAL_URL o INTERNAL_SERVICE_AUTH_SECRET la compra NO descuenta unidades del catalogo.',
          })

          return null
        }

        logger.info('catalog_inventory', { driver: 'catalog' })

        return new CatalogInventoryClient({
          baseUrl: config.catalogInternalUrl,
          secret: config.internalServiceAuthSecret,
          serviceName: config.internalServiceName,
          timeoutMs: config.internalTimeoutMs,
          logger,
        })
      },
      inject: [APP_CONFIG, LOGGER],
    },
    {
      provide: CHECKOUT_DEPENDENCIES,
      useFactory: (
        orders: OrderRepositoryPort,
        payments: PaymentGatewayPort,
        inventory: PlayerInventoryPort,
        clock: ClockPort,
        events: EventPublisherPort,
        catalogInventory: CatalogInventoryPort | null,
      ): CheckoutDependencies => ({
        orders,
        payments,
        inventory,
        clock,
        events,
        // Se OMITE la clave cuando no hay adaptador, en lugar de pasarla como
        // `undefined`: el caso de uso pregunta por su presencia, y una clave
        // presente con valor vacio invita a confundir «no configurado» con
        // «configurado y sin efecto».
        ...(catalogInventory === null ? {} : { catalogInventory }),
      }),
      inject: [
        ORDER_REPOSITORY,
        PAYMENT_GATEWAY,
        PLAYER_INVENTORY,
        CLOCK,
        EVENT_PUBLISHER,
        CATALOG_INVENTORY,
      ],
    },
    {
      provide: CHECKOUT_ORDER,
      useFactory: (
        deps: CheckoutDependencies,
        integrated: IntegratedCheckout | null,
      ): CheckoutOrder | IntegratedCheckout => integrated ?? new CheckoutOrder(deps),
      inject: [CHECKOUT_DEPENDENCIES, INTEGRATED_CHECKOUT],
    },
    {
      provide: CHECKOUT_SUMMARY,
      useFactory: (orders: OrderRepositoryPort): GetCheckoutSummary =>
        new GetCheckoutSummary(orders),
      inject: [ORDER_REPOSITORY],
    },
    {
      provide: SAVED_CART_DEPENDENCIES,
      useFactory: (
        savedCarts: SavedCartRepositoryPort,
        orders: OrderRepositoryPort,
        ids: IdGeneratorPort,
        pricing: ProductPricingPort,
      ): SavedCartDependencies => ({ savedCarts, orders, ids, pricing }),
      inject: [SAVED_CART_REPOSITORY, ORDER_REPOSITORY, ID_GENERATOR, PRODUCT_PRICING],
    },
    {
      provide: SAVE_CART,
      useFactory: (deps: SavedCartDependencies): SaveCart => new SaveCart(deps),
      inject: [SAVED_CART_DEPENDENCIES],
    },
    {
      provide: RESTORE_SAVED_CART,
      useFactory: (deps: SavedCartDependencies): RestoreSavedCart => new RestoreSavedCart(deps),
      inject: [SAVED_CART_DEPENDENCIES],
    },
    {
      provide: GET_SAVED_CART,
      useFactory: (savedCarts: SavedCartRepositoryPort): GetSavedCart =>
        new GetSavedCart(savedCarts),
      inject: [SAVED_CART_REPOSITORY],
    },
    {
      provide: DISCARD_SAVED_CART,
      useFactory: (savedCarts: SavedCartRepositoryPort): DiscardSavedCart =>
        new DiscardSavedCart(savedCarts),
      inject: [SAVED_CART_REPOSITORY],
    },
    {
      provide: READINESS_CHECKS,
      useFactory: (config: AppConfig, db: Kysely<Database> | null): readonly ReadinessCheck[] => {
        if (config.integrationMode === 'local')
          return [{ name: 'development-mode', check: () => true }]
        return [
          {
            name: 'commerce-database',
            check: async (): Promise<boolean> => {
              if (db === null) return false
              await db.selectFrom('orders').select(['version', 'status']).limit(1).execute()
              await db.selectFrom('purchase_attempts').select('id').limit(1).execute()
              await db.selectFrom('purchase_mail_outbox').select('id').limit(1).execute()
              return true
            },
          },
          {
            name: 'catalog-query',
            check: async (): Promise<boolean> =>
              (
                await fetch(
                  configured(config.catalogInternalUrl) + '/api/v1/catalog/products?page=1',
                  { signal: AbortSignal.timeout(config.internalTimeoutMs), redirect: 'error' },
                )
              ).ok,
          },
          {
            name: 'inventory',
            check: async (): Promise<boolean> =>
              (
                await fetch(configured(config.inventoryInternalUrl) + '/api/health/ready', {
                  signal: AbortSignal.timeout(config.internalTimeoutMs),
                  redirect: 'error',
                })
              ).ok,
          },
        ]
      },
      inject: [APP_CONFIG, DATABASE_CONNECTION],
    },
    {
      provide: Symbol('DatabaseShutdown'),
      useFactory: (db: Kysely<Database> | null): { onModuleDestroy: () => Promise<void> } => ({
        onModuleDestroy: async () => {
          if (db !== null) await db.destroy()
        },
      }),
      inject: [DATABASE_CONNECTION],
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
