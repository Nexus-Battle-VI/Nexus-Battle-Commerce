# Arquitectura de Nexus-Battle-Commerce

Commerce conserva pedidos, líneas, wishlist, carrito guardado, intentos de compra
y confirmaciones pendientes de correo. Catalog posee el producto y su stock;
Player/Inventory posee los objetos entregados; Account posee la identidad y el
correo. Los servicios se comunican por HTTP y nunca consultan bases ajenas.

## Capas y adaptadores

Los controladores Nest validan DTO y autenticación; los casos de uso coordinan
puertos; el dominio contiene las reglas y no importa HTTP, ORM ni framework.
`COMMERCE_INTEGRATION_MODE=http` selecciona Catalog canónico, reservas, entrega
al inventario y Notifications reales. Producción exige este modo y PostgreSQL.
`local` conserva adaptadores en memoria para desarrollo; no es una compra integrada.

| Puerto                 | Producción              | Propósito                                 |
| ---------------------- | ----------------------- | ----------------------------------------- |
| OrderRepositoryPort    | PostgresOrderRepository | Pedido, líneas y versión optimista        |
| ProductPricingPort     | HttpCatalogPricing      | Producto canónico por UUID o SKU          |
| PurchaseStore          | PostgresPurchaseStore   | Intento, transiciones y outbox durables   |
| CatalogReservationPort | HttpCatalogReservations | Reservar, confirmar o liberar lote        |
| InventoryGrantPort     | HttpInventoryGrant      | Entregar lote una vez                     |
| PurchaseRecipientPort  | HttpPurchaseRecipient   | Correo registrado mediante JWT en Account |
| PurchaseMailPort       | HttpPurchaseMail        | Correo con productos, cantidades y total  |

## Precios, referencias y carrito

`Money` utiliza enteros en unidades menores y una sola moneda por pedido.
No hay conversión implícita. Se acepta UUID canónico y SKU legado; se resuelven
al mismo producto antes de añadir para evitar líneas duplicadas por alias.
La instantánea conserva UUID, SKU, nombre, imagen y precio pactado.

El checkout mantiene el precio guardado. Modificar o restaurar una línea cuyo
precio vigente cambió devuelve un conflicto y pide retirarla y añadirla de nuevo;
no cambia silenciosamente el importe ni acumula unidades a una cotización vieja.
Restaurar valida el carrito completo antes de sustituir el activo.

PostgreSQL impone un solo carrito DRAFT/PROCESSING por cliente. Las mutaciones
usan versión optimista y bloqueo transaccional para evitar pérdida de líneas.
Wishlist escribe por referencia, sin reemplazar la lista completa. «Adquirido»
procede de una compra efectivamente completada.

## Compra simulada con entrega real

```text
DRAFT → PROCESSING → CONFIRMED
  │          │
  │          └→ DRAFT solo tras rechazo definitivo y compensación segura
  └→ CANCELLED

Intento: RESERVING → RESERVED → DELIVERED → COMPLETED
              │          └→ RELEASING → FAILED
              └→ FAILED si Catalog guarda rechazo definitivo
```

La ruta de pago exige cuatro campos no vacíos. La pasarela es académica y no
mueve dinero. Solo se conserva referencia simulada y número enmascarado; nunca
los cuatro campos ni JWT. El destinatario se resuelve de Account mediante el
testimonio de la petición, sin aceptar una dirección arbitraria del cliente.

El inicio congela versión y contenido en una transacción. Después reserva todo
el lote en Catalog, lo entrega en Inventory y confirma la reserva. El cierre
actualiza el pedido y crea outbox en una transacción PostgreSQL. Un fallo del
outbox impide marcar la compra completada localmente y permite recuperarla.

Todos los comandos internos usan HMAC e identificadores estables. Un timeout
no demuestra que el efecto no ocurrió: se reproduce la misma operación.
Catalog e Inventory guardan también rechazos definitivos, para que un reintento
tardío no entregue una compra que ya se compensó. La confirmación directa y
cancelación de pedidos PROCESSING/CONFIRMED se rechazan; no simulan devoluciones.

`GET /api/orders/:id/payment` y `GET /api/orders/:id/checkout` son lecturas.
No cobran, no entregan y no compensan. La UI puede consultar PROCESSING hasta
recibir el resultado recuperado sin reenviar el formulario.

## Recuperación y correo

`PurchaseRecoveryWorker` procesa vencidos en lotes de 50 cada dos segundos.
`next_attempt_at` hace rotar la cola: un lote de fallos no bloquea los siguientes.
Cada operación tiene su manejo de error; un fallo no interrumpe todo el lote.
El trabajador se detiene al cerrar el módulo y PostgreSQL cierra su pool.

El outbox reintenta el correo independientemente de la entrega. Notifications
guarda un inbox durable para no repetir envíos ya confirmados. Una caída entre
SMTP/SES y guardar SENT conserva una ventana de duplicación de correo; no se
promete exactamente un envío con un proveedor sin idempotencia.

## Migración y operación

`004-integrated-purchases` añade versiones, metadatos, referencias UUID,
unicidad del carrito activo, intentos e índices de recuperación y outbox.
Falla si existen carritos activos duplicados; requiere conciliarlos antes.
Su rollback es forward-only: no borra historia de compras para volver a un
binario que no entiende UUID. Publicar una corrección compatible y conservar
ledgers ante incidentes. Los contratos y el orden de despliegue están en
[Infrastructure](https://github.com/Nexus-Battle-VI/Nexus-Battle-Infrastructure/blob/develop/docs/contracts/ecommerce-integration-v1.md).

Liveness solo comprueba el proceso. Readiness comprueba esquema PostgreSQL,
lectura canónica de Catalog y readiness de Inventory. Notifications puede
recuperarse después mediante outbox, por lo que no bloquea esa sonda.

## Verificación y alcance pendiente

`npm run test:coverage` prueba dominio, HTTP, HMAC y recuperaciones. `npm run test:db`
usa PostgreSQL 17 mediante Testcontainers. Sin Docker, `POSTGRES_TEST_URL`
permite exclusivamente un servidor local: crea una base aleatoria y la elimina
al terminar. La ejecución local del 3 de septiembre utilizó PostgreSQL 16.14;
no sustituye la comprobación de la imagen 17 en CI. Se mantienen los umbrales.
El smoke de Infrastructure conecta los cuatro servicios con MongoDB y PostgreSQL
reales, incluyendo respuestas perdidas y rechazo por capacidad.

El país del perfil pertenece a Account. La selección de moneda regional,
conversión/precios por moneda y promociones requieren una definición comercial;
no se inventan tasas ni descuentos. Los PR no cierran las HU padre ni afirman
que esta implementación ya está desplegada.
