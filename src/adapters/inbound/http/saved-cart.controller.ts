import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Post,
  UnauthorizedException,
} from '@nestjs/common'
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger'

import { DomainError } from '../../../domain/errors/DomainError'
import type {
  DiscardSavedCart,
  GetSavedCart,
  RestoreSavedCart,
  SaveCart,
} from '../../../application/use-cases/SavedCartUseCases'
import {
  DISCARD_SAVED_CART,
  GET_SAVED_CART,
  RESTORE_SAVED_CART,
  SAVE_CART,
} from './tokens.saved-cart'
import { OrderResponse } from './orders.dto'
import { SavedCartResponse } from './saved-cart.dto'
import { CurrentIdentity } from './auth/decorators'
import { ANONYMOUS_IDENTITY } from './auth/anonymous.guard'
import type { VerifiedIdentity } from '../../../application/ports/TokenVerifierPort'

/**
 * Carrito guardado entre sesiones (HU-61).
 *
 * Todas las rutas exigen una identidad **verificada**. HU-61 lo pide de forma
 * explicita: «no se crea una asociacion de carrito atribuida a una identidad
 * inexistente». Con `AUTH_MODE=disabled` el servicio atribuye la identidad
 * literal `anonymous`, que no identifica a nadie: un carrito guardado bajo esa
 * identidad seria el carrito compartido de todo el que pase por el servicio,
 * y devolverselo a la siguiente persona es exactamente el fallo que CA-02
 * prohibe.
 *
 * Por eso estas rutas responden `401` sin proveedor de identidad configurado,
 * en lugar de operar sobre un sujeto que nadie comprobo.
 */
@ApiTags('saved-cart')
@ApiBearerAuth()
@Controller('orders/cart/persistence')
export class SavedCartController {
  constructor(
    @Inject(SAVE_CART) private readonly saveCart: SaveCart,
    @Inject(GET_SAVED_CART) private readonly getSavedCart: GetSavedCart,
    @Inject(RESTORE_SAVED_CART) private readonly restoreSavedCart: RestoreSavedCart,
    @Inject(DISCARD_SAVED_CART) private readonly discardSavedCart: DiscardSavedCart,
  ) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Guarda el carrito vigente para una sesion posterior' })
  @ApiResponse({ status: 200, description: 'Carrito guardado', type: SavedCartResponse })
  @ApiResponse({ status: 400, description: 'No hay un carrito con contenido que guardar' })
  @ApiResponse({ status: 401, description: 'La identidad no esta verificada' })
  async save(@CurrentIdentity() identity: VerifiedIdentity): Promise<SavedCartResponse> {
    const subject = SavedCartController.verifiedSubject(identity)

    try {
      return await this.saveCart.execute(subject)
    } catch (error: unknown) {
      throw SavedCartController.translate(error)
    }
  }

  @Get()
  @ApiOperation({ summary: 'Consulta el carrito guardado de quien realiza la peticion' })
  @ApiResponse({ status: 200, description: 'Carrito guardado', type: SavedCartResponse })
  @ApiResponse({ status: 401, description: 'La identidad no esta verificada' })
  @ApiResponse({ status: 404, description: 'Este cliente no tiene ningun carrito guardado' })
  async find(@CurrentIdentity() identity: VerifiedIdentity): Promise<SavedCartResponse> {
    const subject = SavedCartController.verifiedSubject(identity)
    const saved = await this.getSavedCart.execute(subject)

    if (saved === null) {
      throw new NotFoundException('Este cliente no tiene ningun carrito guardado.')
    }

    return saved
  }

  @Post('restoration')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Vuelca el carrito guardado sobre el carrito vigente' })
  @ApiResponse({ status: 200, description: 'Carrito recuperado', type: OrderResponse })
  @ApiResponse({ status: 401, description: 'La identidad no esta verificada' })
  @ApiResponse({ status: 404, description: 'Este cliente no tiene ningun carrito guardado' })
  async restore(@CurrentIdentity() identity: VerifiedIdentity): Promise<OrderResponse> {
    const subject = SavedCartController.verifiedSubject(identity)

    try {
      return await this.restoreSavedCart.execute(subject)
    } catch (error: unknown) {
      throw SavedCartController.translate(error)
    }
  }

  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Descarta el carrito guardado' })
  @ApiResponse({ status: 204, description: 'Carrito guardado descartado' })
  @ApiResponse({ status: 401, description: 'La identidad no esta verificada' })
  async discard(@CurrentIdentity() identity: VerifiedIdentity): Promise<void> {
    await this.discardSavedCart.execute(SavedCartController.verifiedSubject(identity))
  }

  /**
   * Devuelve el sujeto solo cuando alguien lo verifico.
   *
   * Se compara contra `ANONYMOUS_IDENTITY.subject` y no contra una cadena
   * escrita a mano: si algun dia cambia como se representa "nadie verifico
   * esto", esta comprobacion cambia con ella.
   */
  private static verifiedSubject(identity: VerifiedIdentity): string {
    if (identity.subject === ANONYMOUS_IDENTITY.subject) {
      throw new UnauthorizedException(
        'Guardar el carrito entre sesiones exige una identidad verificada.',
      )
    }

    return identity.subject
  }

  private static translate(error: unknown): Error {
    if (error instanceof DomainError) {
      // Un mensaje sobre "no tiene ningun carrito guardado" es un 404, no un
      // 400: la peticion es correcta, lo que falta es el recurso.
      if (error.message.includes('ningun carrito guardado')) {
        return new NotFoundException(error.message)
      }

      return new BadRequestException(error.message)
    }

    return error instanceof Error ? error : new Error(String(error))
  }
}
