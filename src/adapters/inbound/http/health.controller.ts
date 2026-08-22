import { Controller, Get, HttpCode, HttpStatus, Inject, Res } from '@nestjs/common'
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger'
import type { Response } from 'express'

import {
  buildLiveness,
  buildReadiness,
  buildVersion,
  type HealthReport,
  type ReadinessCheck,
  type VersionReport,
} from '../../../infrastructure/health/health'
import { READINESS_CHECKS, VERSION_REPORT } from './tokens.health'

/**
 * Sondas de salud del servicio.
 *
 * `readiness` responde 503 cuando alguna dependencia falla, para que el
 * orquestador retire la instancia del balanceo en lugar de enviarle trafico.
 */
@ApiTags('health')
@Controller()
export class HealthController {
  constructor(
    @Inject(READINESS_CHECKS) private readonly readinessChecks: readonly ReadinessCheck[],
    @Inject(VERSION_REPORT) private readonly version: VersionReport,
  ) {}

  @Get('health/live')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Confirma que el proceso responde' })
  live(): HealthReport {
    return buildLiveness()
  }

  @Get('health/ready')
  @ApiOperation({ summary: 'Evalua las dependencias del servicio' })
  @ApiResponse({ status: 200, description: 'Todas las dependencias responden' })
  @ApiResponse({ status: 503, description: 'Alguna dependencia no responde' })
  ready(@Res({ passthrough: true }) response: Response): HealthReport {
    const report = buildReadiness(this.readinessChecks)
    response.status(report.status === 'ok' ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE)

    return report
  }

  @Get('version')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Expone servicio, version y entorno' })
  versionInfo(): VersionReport {
    return buildVersion(this.version)
  }
}
