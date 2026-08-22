# Contribución a Nexus-Battle-Commerce

Este es un repositorio de código del producto. Toda contribución ingresa mediante Pull Request hacia `main` y debe ser trazable hasta una Issue de [Nexus-Battle-Management](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management), que es la fuente única de verdad del Product Backlog.

Este repositorio no tiene Issues ni Project propios. Epics, User Stories, Enablers, Tasks y Bugs se gestionan exclusivamente en Management.

## Ramas

La estrategia es _trunk-based_ liviano. La única rama permanente es `main`.

No existen ramas `develop`, `qa`, `staging` ni `release/*`. Los entornos `dev`, `test` y `prod` son entornos de despliegue, no ramas.

Cada cambio se realiza en una rama de corta duración creada desde `main`:

```text
feat/hu-47-confirmar-pedido
fix/bug-12-total-pedido
chore/bootstrap-sprint1-foundation
ci/cache-dependencias
docs/contrato-openapi
test/cobertura-checkout
refactor/saga-de-checkout
```

La rama se elimina automáticamente al integrar el Pull Request.

## Commits

Se utiliza Conventional Commits con los tipos `feat`, `fix`, `docs`, `test`, `refactor`, `chore`, `ci` y `build`.

El título del Pull Request es el mensaje del commit de integración, porque `main` solo admite _squash_:

```text
feat(commerce): [HU-47] confirmar pedido
fix(commerce): [BUG-12] corregir el total del pedido
```

## Trazabilidad

Todo Pull Request debe referenciar su Issue central con el nombre completo del repositorio:

```text
Refs Nexus-Battle-VI/Nexus-Battle-Management#NUMERO
```

Desde este repositorio no se usa `#NUMERO`, porque apuntaría a una Issue local inexistente o equivocada.

`Closes` se emplea únicamente cuando el Pull Request completa totalmente una Task, un Bug o una Task subordinada de un Enabler. **Un Pull Request no cierra la User Story padre.** La HU permanece abierta hasta que todos los módulos estén integrados, se cumpla la Definition of Done, exista evidencia y el Product Owner acepte el resultado.

## Flujo de trabajo

1. Se verifica que la Issue cumple la Definition of Ready.
2. Se crea la rama desde `main` actualizada.
3. Se desarrolla siguiendo Red → Green → Refactor.
4. Se ejecuta la verificación local completa.
5. Se abre el Pull Request y se completa la plantilla.
6. Se atiende la revisión del Code Owner.
7. Se integra mediante _squash_ cuando el pipeline está verde.
8. Se registra la evidencia desde la Issue central.

## Verificación local

Antes de abrir un Pull Request:

```bash
npm ci
npm run lint
npm run format:check
npm run typecheck
npm run test:coverage
npm run build
```

La cobertura global mínima es del **80 %** y está configurada como umbral en Jest: por debajo de ese valor el comando falla.

## Reglas de arquitectura

- El dominio (`src/domain`) no importa NestJS, SDK de AWS, ORM, HTTP ni drivers de base de datos.
- La capa de aplicación (`src/application`) depende de sus puertos, nunca de adaptadores concretos.
- La elección de implementaciones ocurre exclusivamente en `src/infrastructure/bootstrap`.
- Los casos de uso son clases planas sin decoradores: se registran con fábricas explícitas y no dependen del framework.
- No se accede a la base de datos de otro servicio, ni directamente ni mediante claves foráneas.
- No se comparten entidades de dominio entre servicios a través de un paquete común.

Estas restricciones se verifican en CI mediante reglas de ESLint. Un cambio que las incumpla no puede integrarse.

## Pruebas

- Pruebas unitarias con Jest para dominio, aplicación y adaptadores.
- Pruebas de integración con Supertest contra la aplicación NestJS real, sin sustituir adaptadores.
- No se admiten pruebas vacías, pruebas que solo afirman `true`, ni pruebas deshabilitadas sin justificación en el Pull Request.

## Seguridad

No se incorporan secretos, credenciales ni tokens al repositorio. La configuración sensible se entrega por variables de entorno y se documenta sin valores reales en `.env.example`. Ver [SECURITY.md](SECURITY.md).

## Dependencias

Se usa **npm** con `package-lock.json`. Las actualizaciones automáticas están agrupadas y programadas semanalmente; los cambios de versión mayor requieren revisión humana y, cuando afectan la arquitectura, una decisión registrada.
