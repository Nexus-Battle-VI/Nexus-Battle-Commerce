import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
} from '@nestjs/common'
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger'

import { DomainError } from '../../../domain/errors/DomainError'
import type {
  AddToWishlist,
  GetWishlistItemStatus,
  ListWishlist,
  RemoveFromWishlist,
} from '../../../application/use-cases/WishlistUseCases'
import {
  ADD_TO_WISHLIST,
  GET_WISHLIST_ITEM,
  LIST_WISHLIST,
  REMOVE_FROM_WISHLIST,
} from './tokens.wishlist'
import { WishlistItemResponse } from './wishlist.dto'
import type { VerifiedIdentity } from '../../../application/ports/TokenVerifierPort'
import { CurrentIdentity } from './auth/decorators'

/**
 * Adaptador de entrada HTTP de la lista de deseos.
 *
 * Igual que en `OrdersController`: el cliente nunca se declara en la
 * peticion, sale del testimonio verificado. Sin `@Public()`, la ruta hereda
 * la proteccion por defecto del guard global.
 */
@ApiTags('wishlist')
@ApiBearerAuth()
@Controller('wishlist')
export class WishlistController {
  constructor(
    @Inject(ADD_TO_WISHLIST) private readonly addToWishlist: AddToWishlist,
    @Inject(REMOVE_FROM_WISHLIST) private readonly removeFromWishlist: RemoveFromWishlist,
    @Inject(GET_WISHLIST_ITEM) private readonly getItem: GetWishlistItemStatus,
    @Inject(LIST_WISHLIST) private readonly listWishlist: ListWishlist,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Lista las referencias deseadas del cliente, con su marca de adquirido',
  })
  @ApiResponse({ status: 200, type: WishlistItemResponse, isArray: true })
  async list(
    @CurrentIdentity() identity: VerifiedIdentity,
  ): Promise<readonly WishlistItemResponse[]> {
    return this.listWishlist.execute(identity.subject)
  }

  @Get(':sku')
  @ApiOperation({ summary: 'Consulta si una referencia esta en deseos y si ya se adquirio' })
  @ApiResponse({ status: 200, type: WishlistItemResponse })
  @ApiResponse({ status: 400, description: 'La referencia no tiene un formato valido' })
  async status(
    @Param('sku') sku: string,
    @CurrentIdentity() identity: VerifiedIdentity,
  ): Promise<WishlistItemResponse> {
    try {
      return await this.getItem.execute(identity.subject, sku)
    } catch (error: unknown) {
      throw WishlistController.translate(error)
    }
  }

  @Post(':sku')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Anade una referencia a la lista de deseos' })
  @ApiResponse({ status: 200, description: 'Referencia anadida', type: WishlistItemResponse })
  @ApiResponse({ status: 400, description: 'La referencia no tiene un formato valido' })
  async add(
    @Param('sku') sku: string,
    @CurrentIdentity() identity: VerifiedIdentity,
  ): Promise<WishlistItemResponse> {
    try {
      return await this.addToWishlist.execute(identity.subject, sku)
    } catch (error: unknown) {
      throw WishlistController.translate(error)
    }
  }

  @Delete(':sku')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Retira una referencia de la lista de deseos' })
  @ApiResponse({ status: 200, description: 'Referencia retirada', type: WishlistItemResponse })
  @ApiResponse({ status: 400, description: 'La referencia no estaba en la lista' })
  async remove(
    @Param('sku') sku: string,
    @CurrentIdentity() identity: VerifiedIdentity,
  ): Promise<WishlistItemResponse> {
    try {
      return await this.removeFromWishlist.execute(identity.subject, sku)
    } catch (error: unknown) {
      throw WishlistController.translate(error)
    }
  }

  private static translate(error: unknown): Error {
    if (error instanceof DomainError) {
      return new BadRequestException(error.message)
    }

    return error instanceof Error ? error : new Error('Fallo desconocido del servicio.')
  }
}
