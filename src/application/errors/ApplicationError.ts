/**
 * Errores de la capa de aplicacion. Describen el resultado del caso de uso sin
 * conocer el protocolo: la traduccion a HTTP ocurre en el adaptador de entrada.
 */
export class OrderNotFoundError extends Error {
  constructor(id: string) {
    super(`No existe un pedido identificado por "${id}".`)
    this.name = 'OrderNotFoundError'
  }
}

export class ProductNotPurchasableError extends Error {
  constructor(sku: string) {
    super(`El producto "${sku}" no existe en el catalogo o no esta a la venta.`)
    this.name = 'ProductNotPurchasableError'
  }
}
