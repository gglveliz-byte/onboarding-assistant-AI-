/**
 * @archivo src/modules/02-projects-and-keys/application/sdk-handshake.use-case.ts
 * @modulo 02-projects-and-keys (Handshake Criptografico del SDK y Puerto IApiKeyAndHandshakePort)
 * @proposito
 *   Implementa el protocolo de admision y enlace seguro (`POST /api/v1/sdk/handshake`) para
 *   el widget web del usuario final. Valida la clave publica (`pk_live_...`), verifica el
 *   origen HTTP contra `allowed_domains` (con soporte para wildcards y localhost), comprueba
 *   el consentimiento obligatorio de voz/DOM, verifica la solvencia financiera de la
 *   organizacion y emite un token efimero EdDSA de 60 segundos con nonce de un solo uso en Redis.
 *
 * @resumen_contenido
 *   - `ValidateSdkHandshakeUseCase`: Logica integral del handshake del SDK.
 *   - `ApiKeyAndHandshakePortAdapter`: Implementacion oficial del puerto `IApiKeyAndHandshakePort`.
 *
 * @dependencias_internas
 *   - `@shared/infrastructure/database/rls-pool.ts`: Lectura segura del proyecto.
 *   - `@shared/kernel/api-key.util.ts`: Verificacion CRC32 y parseo de Publishable Keys.
 *   - `@shared/kernel/crypto.util.ts`: CSPRNG para nonces y hashing SHA-256.
 *   - `@shared/kernel/result-and-errors.ts`: Errores OriginNotAllowed, Unauthorized, etc.
 *   - `@shared/ports/billing-voice-admin.ports.ts`: Puerto de solvencia financiera `IBillingWhopPort`.
 *   - `@shared/ports/core-modules.ports.ts`: Contrato inmutable `IApiKeyAndHandshakePort`.
 *   - `@modules/01-identity-and-rbac/infrastructure/jwt-eddsa.signer.ts`: Emision de tokens EdDSA.
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `projects`, `api_keys`, `allowed_domains`.
 *   - Redis: `oa:proj:<id>:allowed_domains`, `oa:sdk_handshake:nonce:<jti>`, `oa:apikey:sha256:<hash>`.
 */

import { JwtEddsaSigner } from '@modules/01-identity-and-rbac/infrastructure/jwt-eddsa.signer';
import { RlsDatabasePool } from '@shared/infrastructure/database/rls-pool';
import { ApiKeyUtils } from '@shared/kernel/api-key.util';
import { CryptoUtils } from '@shared/kernel/crypto.util';
import {
  AppError,
  InsufficientFundsError,
  NotFoundError,
  OriginNotAllowedError,
  Result,
  toAppError,
  UnauthorizedError,
  ValidationError,
} from '@shared/kernel/result-and-errors';
import { IBillingWhopPort } from '@shared/ports/billing-voice-admin.ports';
import {
  IApiKeyAndHandshakePort,
  PortFailure,
  SecretKeyValidationSuccess,
} from '@shared/ports/core-modules.ports';
import {
  isOriginMatchingPattern,
  SdkHandshakeInput,
  SdkHandshakeResult,
} from '../domain/projects-keys.entities';
import { PostgresProjectsKeysRepository } from '../infrastructure/postgres-projects-keys.repository';
import { ValidateSecretApiKeyUseCase } from './api-key-lifecycle.use-case';

/**
 * Caso de uso principal del Handshake del SDK Web.
 */
export class ValidateSdkHandshakeUseCase {
  private readonly rlsPool: RlsDatabasePool;
  private readonly repository: PostgresProjectsKeysRepository;
  private readonly jwtSigner: JwtEddsaSigner;
  private readonly billingPort: IBillingWhopPort;

  public constructor(
    rlsPool: RlsDatabasePool,
    repository: PostgresProjectsKeysRepository,
    jwtSigner: JwtEddsaSigner,
    billingPort: IBillingWhopPort
  ) {
    this.rlsPool = rlsPool;
    this.repository = repository;
    this.jwtSigner = jwtSigner;
    this.billingPort = billingPort;
  }

  public async execute(input: SdkHandshakeInput): Promise<Result<SdkHandshakeResult, AppError>> {
    // 1. Verificacion local del checksum CRC32 de la clave publica
    const isValidKeyFormat = ApiKeyUtils.verifyApiKeyChecksum(input.publishableKey);
    if (!isValidKeyFormat) {
      return Result.fail(new UnauthorizedError('Clave publica de SDK malformada o checksum CRC32 invalido'));
    }

    // 2. Parseo estructural de la clave (debe ser pk_...)
    const parsedKey = ApiKeyUtils.parseApiKey(input.publishableKey);
    if (!parsedKey || parsedKey.type !== 'pk') {
      return Result.fail(
        new ValidationError('Se requiere una clave publica valida del SDK (pk_...) para iniciar el handshake')
      );
    }

    // 3. Verificacion de consentimiento del usuario final
    if (!input.endUserConsentGranted) {
      return Result.fail(
        new ValidationError(
          'Se requiere el consentimiento explicito del usuario final (end_user_consent_granted=true) para conectar el asistente',
          ['field: endUserConsentGranted']
        )
      );
    }

    const keyHash = CryptoUtils.sha256Hex(input.publishableKey);

    try {
      // 4. Resolucion de identidad ANTES del contexto de inquilino.
      //
      // La politica de aislamiento de `api_keys` exige conocer la organizacion propietaria para poder
      // leer la fila, y la organizacion solo se conoce tras leerla: es una dependencia circular. Bajo
      // el rol de aplicacion —sin privilegio de omision de politicas— la lectura directa devolvia
      // **cero filas**, de modo que toda validacion respondia «clave inexistente» y el sistema solo
      // funcionaba conectado con un rol privilegiado, es decir con el aislamiento apagado.
      //
      // Se rompe el circulo con una funcion de confianza del motor que recibe unicamente el resumen
      // —nunca la clave en claro— y devuelve la organizacion propietaria. A partir de ahi, todo lo
      // demas ocurre DENTRO del contexto de esa organizacion, de modo que el aislamiento sigue vigente.
      const owner = await this.rlsPool.withClient((client) => this.repository.resolveApiKeyOwnerByHash(client, keyHash));
      if (owner === null) {
        throw new UnauthorizedError('Clave publica inexistente o desconocida');
      }

      const { apiKey, project } = await this.rlsPool.runInTenantTransaction(
        { organizationId: owner.organizationId },
        async (client) => {
          const key = await this.repository.getApiKeyByHash(client, keyHash, owner.organizationId);
          if (!key) {
            throw new UnauthorizedError('Clave publica inexistente o desconocida');
          }
          if (key.projectId !== input.projectId) {
            throw new UnauthorizedError('La clave publica no corresponde al proyecto indicado');
          }
          if (key.revokedAt !== null) {
            throw new UnauthorizedError('La clave publica ha sido revocada');
          }
          const proj = await this.repository.getProjectById(client, key.projectId);
          if (!proj || !proj.isActive) {
            throw new NotFoundError('El proyecto solicitado no existe o se encuentra inactivo');
          }
          return { apiKey: key, project: proj };
        }
      );

      // 5. Validacion de origen contra la lista de dominios permitidos del proyecto
      await this.validateAllowedOrigin(project.id, input.origin);

      // 6. Verificacion de solvencia financiera de la organizacion
      const solvency = await this.billingPort.checkOrganizationSolvency(project.organizationId);
      if (!solvency.ok || !solvency.snapshot.canStartSession) {
        const reason = solvency.ok
          ? (solvency.snapshot.blockedReason ?? 'Saldo de minutos insuficiente')
          : solvency.reason;
        throw new InsufficientFundsError(
          solvency.ok ? solvency.snapshot.availableMinutes : '0.000000',
          solvency.ok ? solvency.snapshot.creditBalanceUsd : '0.000000',
          { details: { organizationId: project.organizationId, reason } }
        );
      }

      // 7. Generar nonce de un solo uso de 32 bytes CSPRNG
      const nonceId = CryptoUtils.generateCsprngToken(32);
      const ttlSeconds = 60;

      // 8. Emitir el token efimero EdDSA (60s)
      const ephemeralWsToken = await JwtEddsaSigner.signEphemeralToken(
        {
          userId: input.externalEndUserId ?? `anon-${nonceId.slice(0, 8)}`,
          organizationId: project.organizationId,
          purpose: 'SDK_HANDSHAKE',
          extraData: {
            projectId: project.id,
            nonceId,
          },
        },
        ttlSeconds
      );

      // 9. Registrar el nonce en Redis con TTL de 60s
      const noncePayload = JSON.stringify({
        projectId: project.id,
        organizationId: project.organizationId,
        externalEndUserId: input.externalEndUserId ?? null,
        createdAt: new Date().toISOString(),
      });
      await this.repository.storeHandshakeNonce(nonceId, noncePayload, ttlSeconds);

      return Result.ok({
        ephemeralWsToken,
        nonceId,
        expiresInSeconds: ttlSeconds,
        projectId: project.id,
        organizationId: project.organizationId,
        voiceSettings: {
          primaryModel: project.primaryVoiceModel,
          voicePersonaCode: project.voicePersonaCode,
          speechSpeed: project.speechSpeed,
          vadSensitivity: project.vadBargeInSensitivity,
        },
      });
    } catch (error) {
      return Result.fail(toAppError(error));
    }
  }

  /**
   * Valida si el origen HTTP presentado coincide con algun patron autorizado del proyecto.
   */
  private async validateAllowedOrigin(projectId: string, origin: string): Promise<void> {
    if (!origin || origin.trim().length === 0) {
      throw new OriginNotAllowedError('Se requiere la cabecera Origin o Referer para el handshake del SDK');
    }

    // 1. Consultar cache de Redis
    let cachedDomains = await this.repository.getCachedProjectDomains(projectId);

    // 2. Si no hay cache, consultar base de datos
    if (!cachedDomains) {
      const dbDomains = await this.rlsPool.withClient(async (client) => {
        return this.repository.listAllowedDomainsByProject(client, projectId);
      });
      cachedDomains = dbDomains.map((d) => ({
        pattern: d.originPattern,
        allowLocalhost: d.allowLocalhostDev,
      }));
    }

    if (cachedDomains.length === 0) {
      throw new OriginNotAllowedError(
        'El proyecto no tiene ningun dominio permitido registrado. Configure un origen en el panel.',
        { details: { origin } }
      );
    }

    // 3. Evaluar coincidencia con alguna regla
    const isAllowed = cachedDomains.some((d) => isOriginMatchingPattern(origin, d.pattern, d.allowLocalhost));

    if (!isAllowed) {
      throw new OriginNotAllowedError(`El origen "${origin}" no esta autorizado para conectarse a este proyecto`, {
        details: {
          origin,
          registeredCount: cachedDomains.length,
        },
      });
    }
  }
}

/**
 * Adaptador que implementa el puerto oficial `IApiKeyAndHandshakePort` del Core.
 */
export class ApiKeyAndHandshakePortAdapter implements IApiKeyAndHandshakePort {
  private readonly validateSecretKeyUseCase: ValidateSecretApiKeyUseCase;
  private readonly rlsPool: RlsDatabasePool;
  private readonly repository: PostgresProjectsKeysRepository;
  private readonly billingPort: IBillingWhopPort;

  public constructor(
    validateSecretKeyUseCase: ValidateSecretApiKeyUseCase,
    rlsPool: RlsDatabasePool,
    repository: PostgresProjectsKeysRepository,
    billingPort?: IBillingWhopPort
  ) {
    this.validateSecretKeyUseCase = validateSecretKeyUseCase;
    this.rlsPool = rlsPool;
    this.repository = repository;
    this.billingPort = billingPort ?? {
      checkOrganizationSolvency: async () => ({
        ok: false,
        code: 'PERSISTENCE_UNAVAILABLE',
        reason: 'Puerto de facturacion no configurado en el adaptador de handshake',
        retryable: false,
      }),
      deductVoiceSessionSlice: async () => {
        throw new Error('BILLING_PORT_UNCONFIGURED');
      },
      grantPromotionalMinutes: async () => {
        throw new Error('BILLING_PORT_UNCONFIGURED');
      },
    };
  }

  public async validateSecretKey(
    rawSecretKey: string,
    requiredScope?: string
  ): Promise<SecretKeyValidationSuccess | PortFailure> {
    const result = await this.validateSecretKeyUseCase.execute(rawSecretKey, requiredScope);
    if (!result.ok) {
      const err = result.error;
      const code = err.code === 'FORBIDDEN' ? 'SCOPE_NOT_GRANTED' : 'API_KEY_INVALID';
      return {
        ok: false,
        code,
        reason: err.message,
        retryable: false,
      };
    }
    return result.value;
  }

  public async validateSdkHandshake(
    rawPublishableKey: string,
    origin: string,
    projectId: string
  ): Promise<
    | {
        readonly ok: true;
        readonly organizationId: string;
        readonly projectId: string;
        readonly issuedNonceId: string;
        readonly nonceTtlSeconds: number;
      }
    | PortFailure
  > {
    // 1. Verificacion CRC32
    if (!ApiKeyUtils.verifyApiKeyChecksum(rawPublishableKey)) {
      return {
        ok: false,
        code: 'API_KEY_INVALID',
        reason: 'Clave publica malformada o checksum CRC32 invalido',
        retryable: false,
      };
    }

    const keyHash = CryptoUtils.sha256Hex(rawPublishableKey);

    try {
      // Resolucion de identidad antes del contexto de inquilino, y lectura de la clave dentro de ese
      // contexto: la politica de aislamiento exige conocer la organizacion propietaria para poder leer
      // la fila, de modo que la lectura sin contexto devolvia cero filas bajo el rol de aplicacion.
      const owner = await this.rlsPool.withClient((client) => this.repository.resolveApiKeyOwnerByHash(client, keyHash));
      const key =
        owner === null
          ? null
          : await this.rlsPool.runInTenantTransaction({ organizationId: owner.organizationId }, (client) =>
              this.repository.getApiKeyByHash(client, keyHash, owner.organizationId)
            );

      if (!key || key.projectId !== projectId || key.revokedAt !== null) {
        return {
          ok: false,
          code: 'API_KEY_INVALID',
          reason: 'Clave publica invalida o no autorizada para este proyecto',
          retryable: false,
        };
      }

      // 2. Validacion de origen
      const domains = await this.rlsPool.withClient(async (client) => {
        return this.repository.listAllowedDomainsByProject(client, projectId);
      });

      const isAllowed = domains.some((d) =>
        isOriginMatchingPattern(origin, d.originPattern, d.allowLocalhostDev)
      );

      if (!isAllowed) {
        return {
          ok: false,
          code: 'ORIGIN_NOT_ALLOWED',
          reason: `El origen ${origin} no se encuentra autorizado en allowed_domains`,
          retryable: false,
        };
      }

      // 3. Comprobacion estricta de solvencia financiera (C1-02: rechaza y falla cerrado ante insolvencia)
      const solvency = await this.billingPort.checkOrganizationSolvency(key.organizationId);
      if (!solvency.ok) {
        return {
          ok: false,
          code: solvency.code,
          reason: solvency.reason,
          retryable: solvency.retryable,
        };
      }

      if (!solvency.snapshot.canStartSession) {
        return {
          ok: false,
          code: 'TENANT_SUSPENDED',
          reason: solvency.snapshot.blockedReason ?? 'Organizacion sin saldo o minutos disponibles para iniciar sesion',
          retryable: false,
        };
      }

      // 4. Emision de nonce efimero de 60 segundos
      const nonceId = CryptoUtils.generateCsprngToken(32);
      const payload = JSON.stringify({
        projectId,
        organizationId: key.organizationId,
        issuedAt: new Date().toISOString(),
      });
      const stored = await this.repository.storeHandshakeNonce(nonceId, payload, 60);
      if (!stored) {
        return {
          ok: false,
          code: 'PERSISTENCE_UNAVAILABLE',
          reason: 'No fue posible registrar el nonce efimero en el almacen de sesiones',
          retryable: true,
        };
      }

      return {
        ok: true,
        organizationId: key.organizationId,
        projectId,
        issuedNonceId: nonceId,
        nonceTtlSeconds: 60,
      };
    } catch (error) {
      const appErr = toAppError(error);
      return {
        ok: false,
        code: 'PERSISTENCE_UNAVAILABLE',
        reason: appErr.message,
        retryable: true,
      };
    }
  }

  public async consumeEphemeralWsNonce(
    nonceId: string,
    projectId: string
  ): Promise<{ readonly ok: true; readonly externalEndUserId: string | null; readonly organizationId: string } | PortFailure> {
    try {
      const rawPayload = await this.repository.consumeHandshakeNonce(nonceId);
      if (!rawPayload) {
        return {
          ok: false,
          code: 'HANDSHAKE_NONCE_REPLAYED',
          reason: 'Nonce efimero invalido, expirado o ya consumido',
          retryable: false,
        };
      }

      const parsed = JSON.parse(rawPayload) as {
        readonly projectId: string;
        readonly organizationId?: string;
        readonly externalEndUserId?: string | null;
      };

      if (parsed.projectId !== projectId) {
        return {
          ok: false,
          code: 'HANDSHAKE_NONCE_INVALID',
          reason: 'El nonce presentado no corresponde al proyecto conectado',
          retryable: false,
        };
      }

      if (parsed.organizationId === undefined || parsed.organizationId.length === 0) {
        // Un nonce emitido sin organizacion no permite atribuir el consumo a ningun tenant, y
        // aceptarlo obligaria a confiar en el identificador que enviara el cliente.
        return {
          ok: false,
          code: 'HANDSHAKE_NONCE_INVALID',
          reason: 'El nonce presentado no declara la organizacion propietaria del proyecto',
          retryable: false,
        };
      }

      return {
        ok: true,
        externalEndUserId: parsed.externalEndUserId ?? null,
        organizationId: parsed.organizationId,
      };
    } catch (error) {
      const appErr = toAppError(error);
      return {
        ok: false,
        code: 'PERSISTENCE_UNAVAILABLE',
        reason: appErr.message,
        retryable: true,
      };
    }
  }
}

