import 'reflect-metadata'

import {
  PersistenceMappingError,
  toLineRows,
  toOrderRow,
  toRestorable,
  type OrderLineRow,
  type OrderRow,
} from '../../src/adapters/outbound/persistence/mapping'
import { OrderStatus, type OrderSnapshot } from '../../src/domain/entities/Order'
import { Money, Quantity, Sku } from '../../src/domain/value-objects/commerce-values'
import { up } from '../../src/adapters/outbound/persistence/migrations/001-orders'
import { describeError } from '../../src/infrastructure/observability/describe-error'

const ORDER: OrderRow = {
  id: 'ord-1',
  customer_id: 'sub-ana',
  status: OrderStatus.Draft,
  currency: 'COP',
}

const line = (sku: string, amount: string, quantity = 1): OrderLineRow => ({
  order_id: 'ord-1',
  sku,
  unit_price_amount: amount,
  quantity,
})

const snapshotOf = (lines: OrderSnapshot['lines']): OrderSnapshot => ({
  id: 'ord-1',
  customerId: 'sub-ana',
  status: OrderStatus.Draft,
  currency: 'COP',
  totalAmount: 0,
  // Derivado, igual que el total: la traduccion a filas lo descarta, porque
  // `toLineRows` solo escribe lo que el agregado no puede recalcular.
  itemCount: lines.reduce((total, current) => total + current.quantity, 0),
  lines,
})

describe('Traduccion entre filas y agregado restaurable', () => {
  it('reconstruye lo necesario para restaurar el pedido', () => {
    expect(toRestorable(ORDER, [line('SKU-A', '1500', 2)])).toEqual({
      id: 'ord-1',
      customerId: 'sub-ana',
      status: OrderStatus.Draft,
      currency: 'COP',
      lines: [{ sku: 'SKU-A', unitPriceAmount: 1500, quantity: 2 }],
    })
  })

  /**
   * `toSnapshot` ordena las lineas por referencia. Si la lectura no hiciera lo
   * mismo, dos lecturas del mismo pedido podrian devolverlas en distinto orden y
   * una comparacion de instantaneas fallaria sin que nada hubiera cambiado.
   */
  it('ordena las lineas por referencia aunque lleguen desordenadas', () => {
    const restorable = toRestorable(ORDER, [
      line('SKU-C', '3'),
      line('SKU-A', '1'),
      line('SKU-B', '2'),
    ])

    expect(restorable.lines.map((entry) => entry.sku)).toEqual(['SKU-A', 'SKU-B', 'SKU-C'])
  })

  it('descompone la instantanea en filas', () => {
    const snapshot = snapshotOf([
      { sku: 'SKU-A', unitPriceAmount: 1500, quantity: 2, subtotalAmount: 3000 },
    ])

    expect(toOrderRow(snapshot)).toEqual(ORDER)
    expect(toLineRows(snapshot)).toEqual([line('SKU-A', '1500', 2)])
  })

  /**
   * El subtotal de la linea y el total del pedido son DERIVADOS: el agregado los
   * calcula y `restore` ni siquiera los acepta. Persistirlos crearia una segunda
   * fuente de verdad, y un total que no cuadra con sus lineas es peor que no
   * tener total.
   */
  it('no persiste el subtotal, que es derivado', () => {
    const filas = toLineRows(
      snapshotOf([{ sku: 'SKU-A', unitPriceAmount: 700, quantity: 3, subtotalAmount: 2100 }]),
    )

    expect(Object.keys(filas[0]!).sort()).toEqual([
      'order_id',
      'quantity',
      'sku',
      'unit_price_amount',
    ])
  })
})

/**
 * El dinero es la parte que no admite aproximaciones.
 *
 * La columna es `bigint`, y el controlador de `pg` la entrega como cadena
 * precisamente porque un entero de 64 bits no cabe en el numero de JavaScript,
 * exacto solo hasta 2^53 - 1. Pasarla por `Number()` a secas redondearia en
 * silencio, y un importe redondeado no se detecta hasta que descuadra la caja.
 */
describe('Importes', () => {
  it('convierte un importe grande pero exacto', () => {
    const restorable = toRestorable(ORDER, [line('SKU-A', '9007199254740991')])

    expect(restorable.lines[0]!.unitPriceAmount).toBe(Number.MAX_SAFE_INTEGER)
  })

  it('rechaza un importe que JavaScript no puede representar con exactitud', () => {
    // Un peso por encima del maximo seguro: `Number()` lo aceptaria y devolveria
    // un valor distinto del que hay guardado.
    expect(() => toRestorable(ORDER, [line('SKU-A', '9007199254740993')])).toThrow(
      PersistenceMappingError,
    )
  })

  it.each([['1.5'], ['abc'], ['']])('rechaza el importe %s', (amount) => {
    expect(() => toRestorable(ORDER, [line('SKU-A', amount)])).toThrow(PersistenceMappingError)
  })

  it('admite un importe de cero', () => {
    expect(toRestorable(ORDER, [line('SKU-A', '0')]).lines[0]!.unitPriceAmount).toBe(0)
  })
})

describe('Validacion de lo que se lee y de lo que se escribe', () => {
  it('rechaza un estado que el dominio no reconoce', () => {
    expect(() => toRestorable({ ...ORDER, status: 'REEMBOLSADO' }, [])).toThrow(
      PersistenceMappingError,
    )
  })

  it('rechaza una moneda que el dominio no admite', () => {
    expect(() => toRestorable({ ...ORDER, currency: 'XYZ' }, [])).toThrow(PersistenceMappingError)
  })

  it.each([
    ['cero', 0],
    ['negativa', -1],
    ['por encima del maximo', Quantity.MAX + 1],
  ])('rechaza escribir una cantidad %s', (_caso, quantity) => {
    const snapshot = snapshotOf([
      { sku: 'SKU-A', unitPriceAmount: 100, quantity, subtotalAmount: 100 * quantity },
    ])

    expect(() => toLineRows(snapshot)).toThrow(PersistenceMappingError)
  })

  it('admite un pedido sin ninguna linea', () => {
    expect(toRestorable(ORDER, []).lines).toEqual([])
    expect(toLineRows(snapshotOf([]))).toEqual([])
  })
})

/**
 * Una migracion NO puede importar el dominio: queda congelada en el tiempo y
 * tiene que seguir siendo ejecutable tal y como se escribio, aunque el dominio
 * cambie despues. Eso obliga a repetir el vocabulario en la restriccion SQL.
 *
 * Estas pruebas son lo que evita que esa duplicacion se convierta en
 * divergencia: si alguien anade un estado, una moneda o cambia el limite de
 * cantidad sin escribir la migracion correspondiente, falla aqui y no en
 * produccion al intentar guardar.
 */
describe('El dominio y la migracion no divergen', () => {
  const sqlDeLaMigracion = up.toString()

  it.each(Object.values(OrderStatus))('la migracion admite el estado %s', (status) => {
    expect(sqlDeLaMigracion).toContain(`'${status}'`)
  })

  it.each(Money.SUPPORTED_CURRENCIES)('la migracion admite la moneda %s', (currency) => {
    expect(sqlDeLaMigracion).toContain(`'${currency}'`)
  })

  it('la migracion no admite valores que el dominio desconoce', () => {
    const enLasRestricciones = [...sqlDeLaMigracion.matchAll(/'([A-Z]{3,})'/g)].map(
      (match) => match[1]!,
    )
    const conocidos: readonly string[] = [
      ...Object.values(OrderStatus),
      ...Money.SUPPORTED_CURRENCIES,
    ]

    expect(enLasRestricciones.filter((value) => !conocidos.includes(value))).toEqual([])
  })

  it('la cota de cantidad coincide con el limite del dominio', () => {
    expect(sqlDeLaMigracion).toContain(`quantity <= ${String(Quantity.MAX)}`)
  })

  /**
   * El patron de la referencia se compara por COMPORTAMIENTO y no leyendo el
   * campo privado de `Sku`: lo que importa es que motor y dominio acepten y
   * rechacen exactamente lo mismo, no que la cadena del patron coincida.
   *
   * Sin esta restriccion en el motor, la clave primaria `(order_id, sku)` solo
   * impediria repetir la cadena exacta: `SKU-A` y `sku-a` convivirian como dos
   * referencias distintas del mismo pedido.
   */
  it('el patron de la referencia acepta y rechaza lo mismo que el dominio', () => {
    const enLaMigracion = /sku ~ '([^']+)'/.exec(sqlDeLaMigracion)?.[1]

    expect(enLaMigracion).toBeDefined()

    const patron = new RegExp(enLaMigracion!)
    const ejemplos = [
      'sku-espada',
      'sku1',
      'a',
      'sku-de-varias-partes',
      'SKU-MAYUSCULAS',
      'sku con espacios',
      '-sku',
      'sku-',
      '1sku',
      '',
    ]

    for (const ejemplo of ejemplos) {
      const loAdmiteElDominio = ((): boolean => {
        try {
          Sku.create(ejemplo)

          return true
        } catch {
          return false
        }
      })()

      // El dominio normaliza antes de comprobar; el motor recibe ya lo
      // normalizado, asi que se le da esa misma forma.
      expect({ ejemplo, motor: patron.test(ejemplo.trim().toLowerCase()) }).toEqual({
        ejemplo,
        motor: loAdmiteElDominio,
      })
    }
  })
})

/**
 * Muchas bibliotecas rechazan con `unknown`. Pasar eso por `String()` a secas
 * convierte cualquier objeto en `[object Object]` justo cuando mas falta hace
 * saber que ocurrio.
 */
describe('describeError', () => {
  it('usa el mensaje cuando es un Error', () => {
    expect(describeError(new Error('algo fallo'))).toBe('algo fallo')
  })

  it('serializa un objeto en lugar de producir [object Object]', () => {
    expect(describeError({ code: '23505', detail: 'duplicado' })).toBe(
      '{"code":"23505","detail":"duplicado"}',
    )
  })

  it.each([
    [undefined, 'undefined'],
    [null, 'null'],
  ])('describe %s sin romperse', (valor, esperado) => {
    expect(describeError(valor)).toBe(esperado)
  })

  it('no se rompe con una estructura circular', () => {
    const circular: Record<string, unknown> = {}
    circular.yo = circular

    expect(describeError(circular)).toBe('error no serializable')
  })
})
