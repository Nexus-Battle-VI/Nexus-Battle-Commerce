# Arquitectura de Nexus-Battle-Commerce

Documento técnico del servicio. La arquitectura del sistema completo, los ADR y los diagramas viven en [Nexus-Battle-Infrastructure](https://github.com/Nexus-Battle-VI/Nexus-Battle-Infrastructure).

## Bounded context

**Commerce** es responsable de qué ha pedido una persona, a qué precio y en qué estado está ese pedido. Su lenguaje ubicuo se limita a pedido, línea, cantidad, precio unitario, subtotal, total y confirmación.

No es responsable de qué **es** un producto: el nombre, la descripción y el precio vigente pertenecen a Catalog. Tampoco de qué posee un jugador, que pertenece a Player/Inventory. Ni de quién es la persona, que pertenece a Account.

### Datos que posee

Commerce es propietario exclusivo de los pedidos y sus líneas. Ningún otro servicio accede a este almacén.

Y, en sentido contrario: **Commerce no accede a la base de datos de Catalog**. Consulta precios por su API a través de `ProductPricingPort`. Un `JOIN` entre pedidos y productos convertiría ambos servicios en uno solo con dos procesos.

## Capas

```text
+-------------------------------------------------------------+
|  adapters/inbound/http   OrdersController                    |
+-------------------------------------------------------------+
|  application             CreateOrder, AddOrderLine,          |
|                          RemoveOrderLine, ConfirmOrder,      |
|                          CancelOrder, GetOrder, ListOrders   |
+-------------------------------------------------------------+
|  domain                  Order, Money, Sku, Quantity,        |
|                          CustomerId, OrderId, eventos        |
+-------------------------------------------------------------+
|  adapters/outbound       InMemoryOrderRepository,            |
|                          LocalCatalogPricing,                |
|                          SystemClock, UuidGenerator          |
+-------------------------------------------------------------+
|  infrastructure          config, observability, health,      |
|                          bootstrap (raiz de composicion)     |
+-------------------------------------------------------------+
```

## El precio se congela al añadir la línea

Es la decisión central del contexto.

```text
addLine(espada, 15.000, 1)   ->  la linea guarda 15.000
Catalog sube el precio a 20.000
addLine(espada, ..., 2)      ->  se acumula la cantidad, el precio sigue en 15.000
total                        ->  3 x 15.000 = 45.000
```

La alternativa — consultar el precio al confirmar — haría que un cambio en Catalog alterase de forma retroactiva lo que la persona vio al comprar. Eso no es un detalle técnico: es la diferencia entre un precio pactado y un precio revisable sin aviso.

El precio se consulta una vez, en `AddOrderLine`, y el agregado lo conserva. Hay una prueba que fija exactamente ese comportamiento.

## El total se calcula, no se almacena

`Order.total` es una propiedad derivada: reduce las líneas sumando `precioUnitario × cantidad`.

Almacenar el total introduce un segundo lugar donde vive la misma verdad, y ambos pueden divergir. Esa divergencia no produce un error visible: produce un pedido cuyo total no coincide con sus líneas, y nadie lo advierte hasta que alguien reclama.

El coste de recalcular es despreciable con el límite de líneas de un pedido.

## Ciclo de vida

```text
        draft()
           |
           v
        DRAFT  ---- confirm() ---->  CONFIRMED
           |                             |
       cancel()                      cancel()
           |                             |
           v                             v
                    CANCELLED
```

`assertEditable()` concentra en un único punto la regla de que un pedido confirmado o cancelado no admite cambios. Cada operación de mutación la invoca primero. Concentrar la regla evita que una operación nueva se olvide de comprobarla, que es la forma habitual en que estas invariantes se rompen con el tiempo.

Cancelar sí se permite sobre un pedido confirmado: una devolución es un caso legítimo.

## Money: enteros y una moneda por pedido

`Money` guarda el importe en la unidad mínima de la moneda y rechaza operar importes de monedas distintas. El pedido fija su moneda al abrirse, y `addLine` rechaza una línea que llegue en otra.

La clase es idéntica a la de Catalog. **Duplicarla es deliberado**: un paquete compartido de objetos de dominio acoplaría ambos servicios y convertiría cualquier cambio en Catalog en un despliegue coordinado de Commerce. La duplicación de treinta líneas es más barata que ese acoplamiento.

## Puertos

| Puerto                | Responsabilidad                            | Implementación actual     |
| --------------------- | ------------------------------------------ | ------------------------- |
| `OrderRepositoryPort` | Persistir y recuperar pedidos              | `InMemoryOrderRepository` |
| `ProductPricingPort`  | Consultar el precio vigente de un producto | `LocalCatalogPricing`     |
| `ClockPort`           | Proveer el instante actual                 | `SystemClock`             |
| `IdGeneratorPort`     | Generar identificadores                    | `UuidGenerator`           |

`ProductPricingPort` es la frontera con Catalog. Su implementación actual usa un catálogo local; la HTTP depende de ADR-006. Lo que ninguna implementación hará es acceder al almacén de Catalog.

## Patrones aplicados

| Patrón                | Dónde                                | Por qué                                                                   |
| --------------------- | ------------------------------------ | ------------------------------------------------------------------------- |
| Ports and Adapters    | Todas las dependencias externas      | Permite sustituir persistencia y origen de precios sin tocar el dominio   |
| Aggregate             | `Order` con sus líneas               | El total y la inmutabilidad son invariantes del pedido completo           |
| Repository            | `OrderRepositoryPort`                | Aísla el agregado del mecanismo de almacenamiento                         |
| State                 | `OrderStatus` con `assertEditable`   | Concentra qué operaciones admite cada estado                              |
| Anti-corruption layer | `ProductPricingPort`                 | Traduce el modelo de Catalog a lo único que Commerce necesita: un importe |
| Domain Events         | `order.confirmed`, `order.cancelled` | Registra hechos de forma trazable                                         |

No se aplica CQRS ni Event Sourcing.

## Eventos de dominio

| Evento                     | Cuándo                                                          |
| -------------------------- | --------------------------------------------------------------- |
| `commerce.order.confirmed` | Se confirma un pedido; incluye total, moneda y número de líneas |
| `commerce.order.cancelled` | Se cancela un pedido; incluye el motivo                         |

`order.confirmed` es el evento que en la arquitectura objetivo dispararía la reserva de inventario y la notificación de confirmación. Esa coordinación no está implementada: ver limitaciones.

## Sobre la saga de checkout

Un checkout completo coordinaría al menos tres contextos: confirmar el pedido, reservar inventario y notificar. Es un proceso de larga duración sin transacción común, y por tanto candidato natural a una saga con compensaciones.

**No está implementada.** El evento `order.confirmed` existe y transporta lo necesario para iniciarla, pero el orquestador, las compensaciones y el transporte dependen de que ADR-006 decida la mensajería. Implementar una saga contra un transporte que todavía no se ha elegido produciría código que habría que rehacer.

## Observabilidad

Registro JSON estructurado por línea, emitido exclusivamente desde `infrastructure/observability/logger.ts`. El resto del código tiene prohibido escribir en la consola mediante la regla `no-console` de ESLint.

## Salud

`/api/health/live` confirma que el proceso responde y no consulta dependencias. `/api/health/ready` evalúa **dos** dependencias reales — el repositorio y el catálogo de precios — y responde `503` cuando alguna falla. Una comprobación que lanza una excepción cuenta como fallo, nunca como éxito.

## Limitaciones conocidas del alcance actual

- **No hay pago.** El alcance llega hasta la confirmación. Integrar una pasarela requiere decisión arquitectónica y revisión de cumplimiento independientes.
- La persistencia es en memoria y se pierde al reiniciar. El adaptador PostgreSQL depende de ADR-005.
- Los precios provienen de un catálogo local, no de una llamada HTTP a Catalog. Depende de ADR-006.
- **No hay control de acceso.** El `customerId` llega sin verificar: cualquiera podría crear o confirmar pedidos a nombre de otra persona. Depende del proveedor de identidad pendiente de aprobación.
- No hay reserva de inventario ni saga de checkout. Ver la sección anterior.

Estas limitaciones están declaradas de forma explícita para que la arquitectura de demo no se confunda con la arquitectura objetivo.
