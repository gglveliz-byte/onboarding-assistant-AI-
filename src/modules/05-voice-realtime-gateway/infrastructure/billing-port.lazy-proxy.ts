/**
 * @archivo src/modules/05-voice-realtime-gateway/infrastructure/billing-port.lazy-proxy.ts
 * @modulo 05-voice-realtime-gateway (Resolucion Perezosa del Puerto de Facturacion)
 * @proposito
 *   El gateway de voz necesita el puerto de facturacion del Modulo 04 para cobrar cada pulso, pero
 *   construirlo de forma anticipada acoplaria el arranque a que el manifiesto de cobros se hubiera
 *   ejecutado antes. Una dependencia de ORDEN en el arranque es la clase de fallo que solo aparece en
 *   produccion y con un mensaje criptico. Este envoltorio resuelve el puerto en la PRIMERA llamada
 *   real, de modo que el orden de registro de los manifiestos deja de importar y ademas elimina la
 *   necesidad de afirmar el tipo con `as never`, que silenciaria un token mal escrito hasta el
 *   momento del cobro.
 *
 * @resumen_contenido
 *   - Funcion `createLazyBillingPort()`: Envoltorio perezoso del puerto de facturacion.
 *   - Funcion `hasBillingPort()`: Comprobacion de disponibilidad sin resolverlo.
 *
 * @dependencias_internas
 *   - `IBillingWhopPort` (`src/shared/ports/billing-voice-admin.ports.ts`).
 *   - `DependencyContainer` y `DI_TOKENS` (`src/shared/container/di-container.ts`).
 *
 * @dependencias_externas
 *   - Ninguna (Envoltorio puro: no abre conexiones ni conoce la implementacion concreta).
 *
 * @tablas_bd_o_redis
 *   - Ninguna (El envoltorio solo delega; el cobro efectivo ocurre en el Modulo 04).
 */

import { DependencyContainer, DI_TOKENS } from '../../../shared/container/di-container';
import type { IBillingWhopPort } from '../../../shared/ports/billing-voice-admin.ports';

/** Mensaje con el que se explica que el modulo de cobros no esta disponible. */
const MISSING_MODULE_REASON =
  'El puerto de facturacion del Modulo 04 no esta registrado en el contenedor. ' +
  'Verifique que registerBillingWhopModule() se ejecuto durante el arranque.';

/**
 * Crea un envoltorio que resuelve el puerto de facturacion en su primera llamada real.
 *
 * Ninguna de las tres operaciones se anticipa: si la organizacion nunca consume voz, el puerto jamas
 * se resuelve y el arranque del gateway no depende de que el modulo de cobros este listo.
 *
 * @param container - Contenedor de inyeccion de dependencias del monolito.
 * @returns Puerto de facturacion con resolucion perezosa.
 */
export function createLazyBillingPort(container: DependencyContainer): IBillingWhopPort {
  /**
   * Resuelve el puerto real en el momento de uso.
   *
   * @returns Implementacion registrada del puerto de facturacion.
   * @throws Error cuando el modulo de cobros no fue registrado en el arranque.
   */
  const resolvePort = (): IBillingWhopPort => {
    if (!container.has(DI_TOKENS.BillingDeductionPort)) {
      throw new Error(MISSING_MODULE_REASON);
    }
    return container.get(DI_TOKENS.BillingDeductionPort) as IBillingWhopPort;
  };

  return {
    checkOrganizationSolvency: (organizationId) => resolvePort().checkOrganizationSolvency(organizationId),
    deductVoiceSessionSlice: (organizationId, voiceSessionId, elapsedSeconds) =>
      resolvePort().deductVoiceSessionSlice(organizationId, voiceSessionId, elapsedSeconds),
    grantPromotionalMinutes: (organizationId, minutesToGrant, reason, grantedBySuperAdminId) =>
      resolvePort().grantPromotionalMinutes(organizationId, minutesToGrant, reason, grantedBySuperAdminId),
  };
}

/**
 * Comprueba si el puerto de facturacion esta registrado, sin resolverlo ni instanciarlo.
 * Se usa en el diagnostico de arranque para avisar de una cadena de modulos incompleta antes de que
 * un usuario final descubra el fallo al intentar hablar.
 *
 * @param container - Contenedor de inyeccion de dependencias del monolito.
 * @returns `true` cuando el puerto de facturacion esta disponible.
 */
export function hasBillingPort(container: DependencyContainer): boolean {
  return container.has(DI_TOKENS.BillingDeductionPort);
}
