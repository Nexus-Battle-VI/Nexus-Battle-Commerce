import { DomainError } from '../errors/DomainError'

/**
 * Identidad de quien compra.
 *
 * Es una referencia al contexto Account: este servicio no conoce el correo ni
 * el nombre de la persona. Solo su identificador.
 */
export class CustomerId {
  readonly value: string

  private constructor(value: string) {
    this.value = value
  }

  static create(raw: string): CustomerId {
    const normalized = raw.trim()

    if (normalized.length === 0) {
      throw new DomainError('El identificador del cliente no puede estar vacio.')
    }

    return new CustomerId(normalized)
  }

  equals(other: CustomerId): boolean {
    return this.value === other.value
  }

  toString(): string {
    return this.value
  }
}

export class OrderId {
  readonly value: string

  private constructor(value: string) {
    this.value = value
  }

  static create(raw: string): OrderId {
    const normalized = raw.trim()

    if (normalized.length === 0) {
      throw new DomainError('El identificador del pedido no puede estar vacio.')
    }

    return new OrderId(normalized)
  }

  equals(other: OrderId): boolean {
    return this.value === other.value
  }

  toString(): string {
    return this.value
  }
}

/**
 * Referencia a un producto del catalogo.
 *
 * Commerce no conoce el nombre ni la descripcion del producto: los obtiene por
 * la API de Catalog cuando los necesita. Aqui solo importa la referencia y el
 * precio acordado en el momento del pedido.
 */
export class Sku {
  private static readonly PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/

  readonly value: string

  private constructor(value: string) {
    this.value = value
  }

  static create(raw: string): Sku {
    const normalized = raw.trim().toLowerCase()

    if (!Sku.PATTERN.test(normalized)) {
      throw new DomainError(`La referencia "${raw}" no es valida. Se espera kebab-case.`)
    }

    return new Sku(normalized)
  }

  equals(other: Sku): boolean {
    return this.value === other.value
  }

  toString(): string {
    return this.value
  }
}

export class Quantity {
  static readonly MAX = 999

  readonly value: number

  private constructor(value: number) {
    this.value = value
  }

  static create(raw: number): Quantity {
    if (!Number.isInteger(raw)) {
      throw new DomainError(`La cantidad debe ser un numero entero. Se recibio ${String(raw)}.`)
    }

    if (raw < 1) {
      throw new DomainError(`La cantidad debe ser mayor o igual a 1. Se recibio ${String(raw)}.`)
    }

    if (raw > Quantity.MAX) {
      throw new DomainError(
        `La cantidad no puede superar ${String(Quantity.MAX)}. Se recibio ${String(raw)}.`,
      )
    }

    return new Quantity(raw)
  }

  plus(other: Quantity): Quantity {
    return Quantity.create(this.value + other.value)
  }

  equals(other: Quantity): boolean {
    return this.value === other.value
  }
}

/**
 * Importe monetario.
 *
 * La cantidad se guarda como **entero en la unidad minima de la moneda**.
 * En un contexto de comercio esto no es un detalle de estilo: el total de un
 * pedido es la suma de sus lineas, y con punto flotante esa suma puede diferir
 * de lo que la persona ve sumando las partes.
 *
 * La definicion es identica a la del contexto Catalog, y esa duplicacion es
 * deliberada: compartir un paquete comun de objetos de dominio acoplaria ambos
 * servicios y convertiria cualquier cambio en Catalog en un despliegue de
 * Commerce.
 */
export class Money {
  static readonly SUPPORTED_CURRENCIES: readonly string[] = ['COP', 'USD', 'EUR']

  readonly amount: number
  readonly currency: string

  private constructor(amount: number, currency: string) {
    this.amount = amount
    this.currency = currency
  }

  static create(amount: number, currency: string): Money {
    const normalizedCurrency = currency.trim().toUpperCase()

    if (!Money.SUPPORTED_CURRENCIES.includes(normalizedCurrency)) {
      throw new DomainError(
        `La moneda "${currency}" no esta soportada. Se admiten: ${Money.SUPPORTED_CURRENCIES.join(', ')}.`,
      )
    }

    if (!Number.isInteger(amount)) {
      throw new DomainError(
        `El importe debe ser un entero en la unidad minima de la moneda. Se recibio ${String(amount)}.`,
      )
    }

    if (amount < 0) {
      throw new DomainError(`El importe no puede ser negativo. Se recibio ${String(amount)}.`)
    }

    return new Money(amount, normalizedCurrency)
  }

  static zero(currency: string): Money {
    return Money.create(0, currency)
  }

  plus(other: Money): Money {
    Money.assertSameCurrency(this, other)

    return Money.create(this.amount + other.amount, this.currency)
  }

  times(factor: number): Money {
    if (!Number.isInteger(factor) || factor < 0) {
      throw new DomainError(
        `El factor debe ser un entero mayor o igual a 0. Se recibio ${String(factor)}.`,
      )
    }

    return Money.create(this.amount * factor, this.currency)
  }

  isZero(): boolean {
    return this.amount === 0
  }

  equals(other: Money): boolean {
    return this.amount === other.amount && this.currency === other.currency
  }

  toString(): string {
    return `${String(this.amount)} ${this.currency}`
  }

  private static assertSameCurrency(left: Money, right: Money): void {
    if (left.currency !== right.currency) {
      throw new DomainError(
        `No se pueden operar importes en monedas distintas: ${left.currency} y ${right.currency}.`,
      )
    }
  }
}
