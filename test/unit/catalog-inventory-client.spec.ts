import { CatalogInventoryClient } from '../../src/adapters/outbound/inventory/CatalogInventoryClient'
import {
  CatalogUnavailableError,
  ProductNotInCatalogError,
  ProductSoldOutError,
} from '../../src/application/ports/CatalogInventoryPort'
import {
  INTERNAL_SERVICE_HEADER,
  INTERNAL_SIGNATURE_HEADER,
  INTERNAL_TIMESTAMP_HEADER,
  signInternalRequest,
} from '../../src/adapters/outbound/identity/internal-signature'

/**
 * Cliente del contrato interno de Catalog (HU-34).
 *
 * LO QUE SE COMPRUEBA AQUI ES LA TRADUCCION, y es lo que decide qué se le dice
 * al comprador: agotado, no existe, o no se pudo preguntar. Mezclarlas
 * convertiría una caída de Catalog en la afirmación de que un producto está
 * agotado, que es falsa.
 *
 * EL SECRETO ES FICTICIO. Nunca debe aparecer aquí uno real: un secreto en el
 * repositorio es un secreto publicado.
 */
const SECRETO = 'secreto-ficticio-solo-para-pruebas'

const registros: { level: string; message: string }[] = []

const logger = {
  debug: (message: string): void => {
    registros.push({ level: 'debug', message })
  },
  info: (message: string): void => {
    registros.push({ level: 'info', message })
  },
  warn: (message: string): void => {
    registros.push({ level: 'warn', message })
  },
  error: (message: string): void => {
    registros.push({ level: 'error', message })
  },
}

const ADQUISICION = {
  acquisitionId: '11111111-1111-4111-8111-111111111111',
  productRef: 'espada-de-hierro',
  playerId: 'acc-1',
}

const clienteCon = (fetchImpl: typeof fetch): CatalogInventoryClient =>
  new CatalogInventoryClient({
    baseUrl: 'http://catalog:3003',
    secret: SECRETO,
    serviceName: 'commerce',
    timeoutMs: 200,
    logger,
    fetchImpl,
  })

const respuesta = (status: number, body: unknown = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

describe('CatalogInventoryClient', () => {
  beforeEach(() => {
    registros.length = 0
  })

  it('descuenta y devuelve las unidades restantes', async () => {
    const cliente = clienteCon(() => Promise.resolve(respuesta(200, { availableUnits: 4 })))

    await expect(cliente.acquire(ADQUISICION)).resolves.toEqual({
      availableUnits: 4,
      soldOut: false,
    })
  })

  it('tiraje infinito devuelve disponibilidad nula y nunca agotado', async () => {
    const cliente = clienteCon(() => Promise.resolve(respuesta(200, { availableUnits: null })))

    await expect(cliente.acquire(ADQUISICION)).resolves.toEqual({
      availableUnits: null,
      soldOut: false,
    })
  })

  it('cero unidades marca agotado en el resultado', async () => {
    const cliente = clienteCon(() => Promise.resolve(respuesta(200, { availableUnits: 0 })))

    await expect(cliente.acquire(ADQUISICION)).resolves.toEqual({
      availableUnits: 0,
      soldOut: true,
    })
  })

  describe('cada respuesta significa una cosa distinta', () => {
    it('409 es agotado', async () => {
      const cliente = clienteCon(() => Promise.resolve(respuesta(409)))

      await expect(cliente.acquire(ADQUISICION)).rejects.toBeInstanceOf(ProductSoldOutError)
    })

    it('404 es que el producto no esta en el catalogo', async () => {
      const cliente = clienteCon(() => Promise.resolve(respuesta(404)))

      await expect(cliente.acquire(ADQUISICION)).rejects.toBeInstanceOf(ProductNotInCatalogError)
    })

    /**
     * CONTROL de las dos anteriores. Un 401 significa que Catalog rechazo
     * nuestra firma, y de ahi NO se sigue que el producto este agotado.
     * Traducirlo a agotado mandaria al administrador a ampliar un tiraje que
     * esta perfectamente bien.
     */
    it('401 es indisponibilidad, NO agotado', async () => {
      const cliente = clienteCon(() => Promise.resolve(respuesta(401)))

      await expect(cliente.acquire(ADQUISICION)).rejects.toBeInstanceOf(CatalogUnavailableError)
    })

    it('500 es indisponibilidad', async () => {
      const cliente = clienteCon(() => Promise.resolve(respuesta(500)))

      await expect(cliente.acquire(ADQUISICION)).rejects.toBeInstanceOf(CatalogUnavailableError)
    })

    it('una respuesta sin el campo esperado es indisponibilidad', async () => {
      const cliente = clienteCon(() => Promise.resolve(respuesta(200, { otraCosa: 1 })))

      await expect(cliente.acquire(ADQUISICION)).rejects.toBeInstanceOf(CatalogUnavailableError)
    })

    it('una disponibilidad que no es numero ni nulo es indisponibilidad', async () => {
      const cliente = clienteCon(() =>
        Promise.resolve(respuesta(200, { availableUnits: 'cuatro' })),
      )

      await expect(cliente.acquire(ADQUISICION)).rejects.toBeInstanceOf(CatalogUnavailableError)
    })

    it('un fallo de red es indisponibilidad', async () => {
      const cliente = clienteCon(() => Promise.reject(new Error('ECONNREFUSED')))

      await expect(cliente.acquire(ADQUISICION)).rejects.toBeInstanceOf(CatalogUnavailableError)
    })
  })

  it('firma la peticion de forma que Catalog puede reproducirla', async () => {
    let capturada: { url: string; init: RequestInit } | null = null

    const cliente = clienteCon((url, init) => {
      // El adaptador siempre pasa una cadena; se comprueba en vez de forzarla,
      // para que un cambio a `Request` no se traduzca en `[object Object]`.
      expect(typeof url).toBe('string')
      capturada = { url: url as string, init: init ?? {} }

      return Promise.resolve(respuesta(200, { availableUnits: 4 }))
    })

    await cliente.acquire(ADQUISICION)

    const { url, init } = capturada as unknown as { url: string; init: RequestInit }
    const headers = init.headers as Record<string, string>
    const path = '/api/internal/v1/catalog/products/espada-de-hierro/acquisitions'

    expect(url).toBe(`http://catalog:3003${path}`)
    expect(headers[INTERNAL_SERVICE_HEADER]).toBe('commerce')

    // El control que da sentido a la firma: se recalcula con la MISMA ruta y el
    // MISMO cuerpo, y coincide. Si el cliente firmara otra ruta -o solo el
    // cuerpo-, esto no cuadraria y Catalog respondería 401.
    const esperada = signInternalRequest(SECRETO, {
      service: 'commerce',
      method: 'POST',
      path,
      timestamp: headers[INTERNAL_TIMESTAMP_HEADER] ?? '',
      body: { acquisitionId: ADQUISICION.acquisitionId, playerId: ADQUISICION.playerId },
    })

    expect(headers[INTERNAL_SIGNATURE_HEADER]).toBe(esperada)
  })

  it('no escribe la firma ni el secreto en el registro', async () => {
    const cliente = clienteCon(() => Promise.resolve(respuesta(500)))

    await expect(cliente.acquire(ADQUISICION)).rejects.toBeInstanceOf(CatalogUnavailableError)

    // Un registro con la firma convierte los propios registros en el material
    // que la protege.
    const todo = JSON.stringify(registros)

    expect(todo).not.toContain(SECRETO)
    expect(registros.some((r) => r.message === 'catalog_inventory_respuesta_no_ok')).toBe(true)
  })
})
