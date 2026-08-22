export interface HealthReport {
  readonly status: 'ok' | 'error'
  readonly checks: Readonly<Record<string, 'ok' | 'error'>>
}

export interface ReadinessCheck {
  readonly name: string
  check: () => boolean
}

export interface VersionReport {
  readonly service: string
  readonly version: string
  readonly nodeEnv: string
}

/**
 * Liveness: el proceso responde. No consulta dependencias, porque reiniciar el
 * servicio no repara una dependencia caida.
 */
export const buildLiveness = (): HealthReport => ({ status: 'ok', checks: {} })

/**
 * Readiness: evalua las dependencias reales. Nunca devuelve `ok` de forma
 * incondicional; una readiness falsa es peor que no tenerla.
 */
export const buildReadiness = (checks: readonly ReadinessCheck[]): HealthReport => {
  const results: Record<string, 'ok' | 'error'> = {}
  let healthy = true

  for (const item of checks) {
    let outcome: 'ok' | 'error'

    try {
      outcome = item.check() ? 'ok' : 'error'
    } catch {
      outcome = 'error'
    }

    results[item.name] = outcome

    if (outcome === 'error') {
      healthy = false
    }
  }

  return { status: healthy ? 'ok' : 'error', checks: results }
}

export const buildVersion = (params: VersionReport): VersionReport => ({
  service: params.service,
  version: params.version,
  nodeEnv: params.nodeEnv,
})
