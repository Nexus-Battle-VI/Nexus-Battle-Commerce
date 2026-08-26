import type { Config } from 'jest'

/**
 * Pruebas que necesitan una base de datos real, en su propia configuracion.
 *
 * Estan separadas de `jest.config.ts` a proposito: levantan PostgreSQL en un
 * contenedor con Testcontainers, y meterlas en la suite por defecto obligaria a
 * tener Docker a cualquiera que ejecute `npm test`. Quien trabaje en el dominio
 * o en los casos de uso no deberia necesitarlo.
 *
 * El CI ejecuta ambas: `npm test` y `npm run test:db`.
 */
const config: Config = {
  rootDir: '.',
  displayName: 'db',
  testEnvironment: 'node',
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }],
  },
  moduleFileExtensions: ['ts', 'js', 'json'],
  testMatch: ['<rootDir>/test/db/**/*.spec.ts'],
  // Arrancar la imagen de PostgreSQL la primera vez puede tardar bastante mas
  // que el limite por defecto de Jest.
  testTimeout: 120_000,

  // Esta suite mide SU propia superficie: el adaptador de PostgreSQL y la
  // infraestructura de persistencia, que la suite por defecto no puede ver.
  // Entre las dos configuraciones no queda codigo sin medir.
  collectCoverageFrom: [
    'src/adapters/outbound/persistence/PostgresOrderRepository.ts',
    'src/infrastructure/persistence/**/*.ts',
    '!src/infrastructure/persistence/migrate.ts',
  ],
  coverageDirectory: 'coverage-db',
  coverageReporters: ['text-summary'],
  coverageThreshold: {
    global: { branches: 80, functions: 80, lines: 80, statements: 80 },
  },
}

export default config
