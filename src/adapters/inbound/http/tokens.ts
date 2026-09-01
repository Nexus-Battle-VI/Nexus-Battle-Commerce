/**
 * Tokens de inyeccion de los casos de uso.
 *
 * Los casos de uso son clases sin decoradores: no conocen NestJS. Se registran
 * mediante proveedores explicitos en el modulo.
 */
export const CREATE_ORDER = Symbol('CreateOrder')
export const ADD_LINE = Symbol('AddOrderLine')
export const REMOVE_LINE = Symbol('RemoveOrderLine')
export const CONFIRM_ORDER = Symbol('ConfirmOrder')
export const CANCEL_ORDER = Symbol('CancelOrder')
export const GET_ORDER = Symbol('GetOrder')
export const LIST_ORDERS = Symbol('ListCustomerOrders')
export const CHANGE_LINE_QUANTITY = Symbol('ChangeOrderLineQuantity')
export const GET_CART = Symbol('GetCart')
export const GET_OR_CREATE_CART = Symbol('GetOrCreateCart')
