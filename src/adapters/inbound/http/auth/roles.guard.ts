import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common'
import { Reflector } from '@nestjs/core'

import type { Role } from '../../../../application/ports/TokenVerifierPort'
import { REQUIRED_ROLES, type RequestWithIdentity } from './decorators'

/**
 * Comprueba que la identidad ya verificada posee alguno de los roles exigidos.
 *
 * Se ejecuta DESPUES de JwtAuthGuard y depende de que este haya dejado la
 * identidad en la peticion. Si no hay identidad, deniega: el orden de los
 * guards es una garantia, no una suposicion.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<readonly Role[] | undefined>(REQUIRED_ROLES, [
      context.getHandler(),
      context.getClass(),
    ])

    if (required === undefined || required.length === 0) {
      return true
    }

    const identity = context.switchToHttp().getRequest<RequestWithIdentity>().identity

    if (identity === undefined) {
      throw new ForbiddenException('La peticion no lleva una identidad verificada.')
    }

    if (!required.some((role) => identity.roles.has(role))) {
      throw new ForbiddenException('La identidad no posee el rol necesario para esta operacion.')
    }

    return true
  }
}
