import {
  ConflictException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common'
import {
  CheckoutConflictError,
  IntegrationRejectedError,
  IntegrationUnavailableError,
} from '../../../application/ports/CommerceIntegrationPorts'
import { ProductNotPurchasableError } from '../../../application/errors/ApplicationError'

export const translateIntegrationError = (error: unknown): Error | null => {
  if (error instanceof ProductNotPurchasableError)
    return new UnprocessableEntityException(error.message)
  if (error instanceof CheckoutConflictError) return new ConflictException(error.message)
  if (error instanceof IntegrationRejectedError)
    return new UnprocessableEntityException(error.message)
  if (error instanceof IntegrationUnavailableError)
    return new ServiceUnavailableException(error.message)
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === '23505' &&
    'constraint' in error &&
    error.constraint === 'orders_one_live_cart'
  )
    return new ConflictException('Ya existe un carrito vigente para este cliente.')
  return null
}
