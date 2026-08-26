# Nexus-Battle-Commerce

Servicio de comercio de Nexus Battles VI. Implementa el bounded context **Commerce**: pedidos, líneas, totales y su ciclo de vida.

Este repositorio contiene código y Pull Requests. No contiene Issues ni Product Backlog: la fuente única de verdad es [Nexus-Battle-Management](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management).

- **Team propietario:** Team Beta
- **Arquitectura interna:** Clean + Hexagonal, con puertos y adaptadores
- **Base de datos objetivo:** PostgreSQL (ver limitaciones más abajo)
- **Documentación técnica del sistema:** [Nexus-Battle-Infrastructure](https://github.com/Nexus-Battle-VI/Nexus-Battle-Infrastructure)

## Este servicio no procesa pagos

El alcance actual llega hasta la **confirmación del pedido**. No hay pasarela de pago, no se almacenan datos de tarjeta y no se mueve dinero. Integrar un pago requiere una decisión arquitectónica y una revisión de cumplimiento independientes; no debe añadirse de forma incremental.

## Las tres decisiones que gobiernan el dominio

**1. El precio se congela al añadir la línea.** El pedido conserva el importe que el catálogo devolvió en ese momento, no una referencia viva. Si el precio se consultara al confirmar, un cambio en Catalog alteraría de forma retroactiva lo que la persona vio al comprar.

```text
anadir espada (catalogo dice 15.000)  -> linea a 15.000
Catalog sube el precio a 20.000
anadir 2 espadas mas                  -> se acumulan al precio original: 3 x 15.000
```

**2. El total se calcula, no se almacena.** Un total almacenado puede quedar desincronizado de las líneas que lo justifican, y esa divergencia es invisible hasta que alguien la reclama.

**3. Un pedido confirmado es inmutable.** Ni añadir, ni retirar, ni volver a confirmar. La regla se concentra en un único punto del agregado para que ninguna operación pueda saltársela por descuido.

## Los importes son enteros

`Money` guarda la cantidad en la **unidad mínima de la moneda**. En comercio esto no es un detalle de estilo: el total es la suma de las líneas, y con punto flotante esa suma puede diferir de lo que la persona ve sumando las partes.

La definición es idéntica a la del contexto Catalog, y **esa duplicación es deliberada**: compartir un paquete común de objetos de dominio acoplaría ambos servicios y convertiría cualquier cambio en Catalog en un despliegue de Commerce.

## Verificacion de identidad

El servicio comprueba el testimonio que acompana a cada peticion contra el JWKS del user pool de Cognito ([ADR-004](https://github.com/Nexus-Battle-VI/Nexus-Battle-Infrastructure/blob/main/docs/adr/ADR-004-identity-directory.md)). Se verifica el **token de acceso**, no el de identidad: el de identidad describe al usuario para la interfaz, el de acceso es el que autoriza y el unico cuyo `client_id` puede comprobarse.

La comprobacion de firma la hace [`aws-jwt-verify`](https://github.com/awslabs/aws-jwt-verify). **No se implementa verificacion criptografica a mano**: es la clase de codigo donde un error sutil no falla, sino que acepta tokens falsificados en silencio.

**La proteccion es el comportamiento por defecto.** El guard se registra de forma global y hay que excluir explicitamente lo que deba ser publico con `@Public()`. Al reves, cualquier endpoint nuevo naceria desprotegido y ese olvido no falla ninguna prueba.

| Ruta                                         | Proteccion                                               |
| -------------------------------------------- | -------------------------------------------------------- |
| `POST /api/orders`                           | Testimonio valido. El cliente sale del `sub`             |
| `GET /api/orders`                            | Testimonio valido. Devuelve **solo los pedidos propios** |
| `GET /api/orders/:id` y todas las mutaciones | Testimonio valido **y propiedad del pedido**             |
| `GET /api/health/*`                          | **Publica**                                              |

### `customerId` salio del contrato

Estaba en el cuerpo y en la cadena de consulta. Cualquiera podia abrir pedidos a nombre de otra persona, listar los suyos y confirmarlos. Ahora sale del `sub` del testimonio.

Un pedido ajeno responde **404 y no 403**: distinguirlos confirmaria que el pedido existe, y con eso se pueden enumerar pedidos ajenos probando identificadores. Un administrador queda exento.

### Un binario de produccion sin autenticacion no arranca

Con `NODE_ENV=production` y `AUTH_MODE=disabled`, `loadConfig` lanza `ConfigurationError` y el servicio **no llega a escuchar**. Es la traduccion en codigo del blocker de ADR-004: un aviso en el registro se pasa por alto; un arranque que falla, no.

| Variable             | Efecto                                                                   |
| -------------------- | ------------------------------------------------------------------------ |
| `AUTH_MODE=disabled` | Se atribuye la **identidad anonima** a toda peticion. Estado del blocker |
| `AUTH_MODE=jwt`      | Exige `COGNITO_USER_POOL_ID` y `COGNITO_CLIENT_ID`                       |

Con `disabled` no se deja pasar sin mas: se atribuye el sujeto literal `anonymous` con todos los roles. Sin proveedor **no se sabe** quien realiza la peticion, y el dato que se guarde debe decirlo. Un registro firmado por `anonymous` es honesto; uno firmado por un identificador sin verificar, no.

Los roles llegan en el claim `cognito:groups`. **Los grupos que no corresponden a un rol conocido se descartan**: aceptarlos convertiria el pool en una fuente de roles arbitrarios, donde bastaria crear un grupo con cualquier nombre para inventar un permiso.

## Requisitos

| Herramienta | Versión                                       |
| ----------- | --------------------------------------------- |
| Node.js     | 24 LTS (`.nvmrc` fija el major 24)            |
| npm         | 11 o superior                                 |
| Docker      | opcional, para construir y ejecutar la imagen |

Este repositorio usa **npm** y `package-lock.json`. No se utilizan pnpm ni yarn.

## Puesta en marcha

```bash
nvm use
npm ci
cp .env.example .env
npm run dev
```

Con la configuración por defecto el servicio arranca con el repositorio en memoria y el catálogo local de precios: no requiere base de datos ni otros servicios.

Documentación interactiva de la API en `http://localhost:3005/api/docs`.

## API

| Método   | Ruta                                | Descripción                                                    |
| -------- | ----------------------------------- | -------------------------------------------------------------- |
| `POST`   | `/api/orders`                       | Abre un pedido en borrador                                     |
| `GET`    | `/api/orders?customerId=`           | Lista los pedidos de un cliente                                |
| `GET`    | `/api/orders/:orderId`              | Recupera un pedido                                             |
| `POST`   | `/api/orders/:orderId/lines`        | Añade unidades de un producto                                  |
| `DELETE` | `/api/orders/:orderId/lines/:sku`   | Retira una referencia                                          |
| `POST`   | `/api/orders/:orderId/confirmation` | Confirma el pedido                                             |
| `POST`   | `/api/orders/:orderId/cancellation` | Cancela el pedido                                              |
| `GET`    | `/api/health/live`                  | El proceso responde. No consulta dependencias                  |
| `GET`    | `/api/health/ready`                 | Evalúa las dependencias reales. Responde `503` si alguna falla |
| `GET`    | `/api/version`                      | Servicio, versión y entorno                                    |

**El contrato de alta de línea no acepta el precio.** Lo determina el catálogo, no quien compra. Un producto que no está a la venta responde `422`, no `404`: el pedido sí existe; lo que no se puede procesar es el contenido.

## Scripts

Los mismos que el resto de servicios del producto: `dev`, `build`, `start`, `start:prod`, `typecheck`, `lint`, `lint:fix`, `format`, `format:check`, `test`, `test:unit`, `test:integration`, `test:coverage`. La cobertura mínima exigida es del **80 %** y está configurada como umbral en Jest.

## Estructura

```text
src/
  domain/            Order, objetos de valor (Money, Sku, Quantity) y eventos.
  application/       Casos de uso, puertos, DTO y errores.
  adapters/
    inbound/http/    Controladores y contratos HTTP.
    outbound/        Persistencia, precios y utilidades de sistema.
  infrastructure/    Configuracion, observabilidad, salud y raiz de composicion.
test/
  unit/              Pruebas unitarias por capa.
  integration/       API real levantada con el modulo completo.
```

El dominio no importa NestJS, SDK de AWS, ORM, HTTP ni drivers de base de datos. La restricción se verifica en CI mediante reglas de ESLint.

## Versión de TypeScript

**TypeScript 5.9.3**, no 7, porque `@nestjs/cli@11.0.24` la declara como dependencia directa. Es la misma decisión que en el resto de servicios NestJS y está registrada en ADR-002.

## Docker

```bash
docker build -t nexus-battle-commerce:local .
docker run --rm -p 3005:3005 nexus-battle-commerce:local
```

La imagen es multi-etapa, se ejecuta con el usuario sin privilegios `node`, incluye solo dependencias de producción y no contiene secretos.

## Limitaciones conocidas del alcance actual

- **No hay pago.** Ver la sección correspondiente arriba.
- **La persistencia es en memoria** y se pierde al reiniciar. El adaptador PostgreSQL depende de que ADR-005 decida el ORM. Configurar `PERSISTENCE_DRIVER=postgres` valida la configuración y lo advierte en el registro, pero no habilita un adaptador que no existe.
- **Los precios provienen de un catálogo local**, no de una llamada HTTP a Catalog. `LocalCatalogPricing` es una implementación completa del puerto, no una simulación del servicio; el adaptador HTTP depende de que ADR-006 defina la integración. Lo que este servicio **nunca** hace es leer la base de datos de Catalog.
- **No hay control de acceso.** El `customerId` llega en la petición sin verificar: cualquiera podría crear o confirmar pedidos a nombre de otra persona. Resolverlo depende del proveedor de identidad pendiente de aprobación.
- **No hay reserva de inventario ni saga de checkout completa.** Confirmar un pedido no descuenta stock ni coordina con Player/Inventory. Esa coordinación es un proceso de larga duración entre servicios y depende de ADR-006.

## Contribución

Se aplican las convenciones descritas en [CONTRIBUTING.md](CONTRIBUTING.md) y la [política de trazabilidad entre repositorios](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/blob/main/docs/governance/cross-repository-traceability.md) de Management.

## Licencia

`Licensing pending project governance`. Este repositorio todavía no tiene una licencia asignada; su definición requiere autorización del gobierno del proyecto.
