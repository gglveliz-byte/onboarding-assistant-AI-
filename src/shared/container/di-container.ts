/**
 * @archivo src/shared/container/di-container.ts
 * @modulo 00-kernel (Contenedor de Inyeccion de Dependencias y Registro de Tokens)
 * @proposito
 *   Implementa el mecanismo de auto-conexion que permite a cada modulo registrar sus casos de
 *   uso, repositorios y adaptadores sin que ningun agente de IA tenga que editar un archivo
 *   central de arranque (lo que provocaria conflictos de merge y superaria el tope de 500
 *   lineas). Cada modulo publica su propio manifiesto `register<Modulo>Module(container, ...)` y
 *   este contenedor resuelve las dependencias por token tipado. El registro es estricto: registrar
 *   dos veces el mismo token es un error de programacion, no un reemplazo silencioso.
 *
 * @resumen_contenido
 *   - Clase abstracta `DependencyToken<T>`: Token tipado con nombre legible para diagnostico.
 *   - Funcion `createDependencyToken()`: Fabrica de tokens con tipo inferido.
 *   - Constante `DI_TOKENS`: Catalogo completo e inmutable de tokens de la plataforma.
 *   - Clase `DependencyContainer`:
 *       * `registerInstance()`: Registra una implementacion ya construida (singleton).
 *       * `registerFactory()`: Registra una fabrica perezosa resuelta en el primer uso.
 *       * `get()`: Resuelve un token y falla con un mensaje en espanol si no esta registrado.
 *       * `tryGet()`, `has()` y `listRegisteredTokens()`: Diagnostico y comprobacion.
 *       * `createScope()`: Vista hija para aislar dependencias de una prueba o de un tenant.
 *
 * @dependencias_internas
 *   - `InternalError` (`../kernel/result-and-errors.ts`) para el fallo de resolucion.
 *
 * @dependencias_externas
 *   - Ninguna (Contenedor propio: prohibido instalar una libreria de inyeccion de dependencias).
 *
 * @tablas_bd_o_redis
 *   - Ninguna (Contenedor puramente en memoria).
 */

import { InternalError } from '../kernel/result-and-errors';

/**
 * Token tipado de inyeccion de dependencias.
 * El parametro de tipo solo existe en tiempo de compilacion: en ejecucion el token es una cadena
 * unica con un nombre legible, lo que hace que los errores de resolucion sean diagnosticables.
 */
export abstract class DependencyToken<TService> {
  /** Nombre legible del token, usado en mensajes de error y diagnosticos. */
  public readonly tokenName: string;

  /** Marca de tipo que impide asignar un token de un servicio a una variable de otro servicio. */
  public declare readonly __serviceType?: TService;

  /**
   * Construye el token con su nombre legible.
   *
   * @param tokenName - Nombre unico del token.
   */
  protected constructor(tokenName: string) {
    this.tokenName = tokenName;
  }

  /**
   * Devuelve el nombre del token para que aparezca correctamente en registros y depuracion.
   *
   * @returns Nombre legible del token.
   */
  public toString(): string {
    return `DependencyToken<${this.tokenName}>`;
  }
}

/**
 * Crea un token tipado de inyeccion de dependencias.
 *
 * @param tokenName - Nombre unico y legible del token.
 * @returns Token que resuelve al tipo de servicio indicado.
 */
export function createDependencyToken<TService>(tokenName: string): DependencyToken<TService> {
  return new (class extends DependencyToken<TService> {
    public constructor() {
      super(tokenName);
    }
  })();
}

/**
 * Catalogo completo de tokens de la plataforma.
 * Cada modulo resuelve sus dependencias por estos tokens, jamas importando la implementacion
 * concreta de otro modulo.
 */
export const DI_TOKENS = Object.freeze({
  // --- Infraestructura compartida -------------------------------------------------
  EnvironmentConfig: createDependencyToken<unknown>('EnvironmentConfig'),
  LoggerPort: createDependencyToken<unknown>('LoggerPort'),
  RlsDatabasePool: createDependencyToken<unknown>('RlsDatabasePool'),
  RedisClusterClient: createDependencyToken<unknown>('RedisClusterClient'),
  RateLimiter: createDependencyToken<unknown>('RateLimiter'),
  DomainEventBus: createDependencyToken<unknown>('DomainEventBus'),

  // --- Puertos de los modulos 01, 02 y 03 ----------------------------------------
  IdentityAuthPort: createDependencyToken<unknown>('IdentityAuthPort'),
  ApiKeyValidationPort: createDependencyToken<unknown>('ApiKeyValidationPort'),

  // --- Puertos de los modulos 04, 05 y 06 ----------------------------------------
  BillingDeductionPort: createDependencyToken<unknown>('BillingDeductionPort'),
  VoiceRealtimeProvider: createDependencyToken<unknown>('VoiceRealtimeProvider'),
  VoiceGatewayControlPort: createDependencyToken<unknown>('VoiceGatewayControlPort'),
  AuditLoggerPort: createDependencyToken<unknown>('AuditLoggerPort'),

  // --- Puertos heredados del contrato ampliado del Ledger ------------------------
  RagMapQueryPort: createDependencyToken<unknown>('RagMapQueryPort'),
  VisualTrainerPort: createDependencyToken<unknown>('VisualTrainerPort'),
  SuperAdminGovernancePort: createDependencyToken<unknown>('SuperAdminGovernancePort'),
  SdkHandshakePort: createDependencyToken<unknown>('SdkHandshakePort'),

  // --- Registros de transporte ---------------------------------------------------
  HttpRouterRegistry: createDependencyToken<unknown>('HttpRouterRegistry'),
  WsRouteRegistry: createDependencyToken<unknown>('WsRouteRegistry'),
});

/** Entrada de registro almacenada por el contenedor. */
interface RegistryEntry {
  readonly kind: 'INSTANCE' | 'FACTORY';
  value: unknown;
  readonly factory?: () => unknown;
  resolved: boolean;
}

/**
 * Contenedor de inyeccion de dependencias con resolucion perezosa y registro estricto.
 */
export class DependencyContainer {
  private readonly registry = new Map<DependencyToken<never>, RegistryEntry>();
  private readonly tokenNames = new Set<string>();

  /** Contenedor padre consultado como respaldo cuando el token no existe en este ambito. */
  private parent: DependencyContainer | undefined;

  /**
   * Registra una implementacion ya construida como singleton del contenedor.
   *
   * @param token - Token tipado bajo el que se registra el servicio.
   * @param instance - Implementacion concreta del servicio.
   * @throws InternalError cuando el token ya habia sido registrado.
   */
  public registerInstance<TService>(token: DependencyToken<TService>, instance: TService): void {
    this.assertNotRegistered(token);
    this.registry.set(token as DependencyToken<never>, { kind: 'INSTANCE', value: instance, resolved: true });
    this.tokenNames.add(token.tokenName);
  }

  /**
   * Registra una fabrica perezosa: la instancia se construye en el primer `get()`.
   * Es el mecanismo que usa cada manifiesto de modulo para conectar sus adaptadores sin
   * construir infraestructura que quiza no se use en este Node Pool.
   *
   * @param token - Token tipado bajo el que se registra el servicio.
   * @param factory - Funcion que construye la implementacion concreta.
   * @throws InternalError cuando el token ya habia sido registrado.
   */
  public registerFactory<TService>(token: DependencyToken<TService>, factory: () => TService): void {
    this.assertNotRegistered(token);
    this.registry.set(token as DependencyToken<never>, { kind: 'FACTORY', value: undefined, factory, resolved: false });
    this.tokenNames.add(token.tokenName);
  }

  /**
   * Resuelve un servicio por su token, construyendo la fabrica en el primer uso.
   *
   * @param token - Token tipado del servicio solicitado.
   * @returns Implementacion concreta del servicio.
   * @throws InternalError cuando el token no esta registrado en este contenedor.
   */
  public get<TService>(token: DependencyToken<TService>): TService {
    const entry = this.registry.get(token as DependencyToken<never>);
    if (entry === undefined) {
      if (this.parent !== undefined) {
        return this.parent.get(token);
      }
      throw new InternalError(
        `DEPENDENCIA_NO_REGISTRADA: el token "${token.tokenName}" no fue registrado. ` +
          `Verifique que el manifiesto del modulo correspondiente se ejecuto antes de resolverlo.`
      );
    }

    if (entry.kind === 'INSTANCE') {
      return entry.value as TService;
    }

    if (!entry.resolved || entry.value === undefined) {
      const built = entry.factory?.() as TService;
      entry.value = built;
      entry.resolved = true;
      return built;
    }

    return entry.value as TService;
  }

  /**
   * Resuelve un servicio devolviendo `undefined` en lugar de lanzar cuando no esta registrado.
   *
   * @param token - Token tipado del servicio solicitado.
   * @returns Implementacion concreta, o `undefined` si el token no esta registrado.
   */
  public tryGet<TService>(token: DependencyToken<TService>): TService | undefined {
    if (this.registry.has(token as DependencyToken<never>)) {
      return this.get(token);
    }
    return this.parent?.tryGet(token);
  }

  /**
   * Comprueba si un token ya fue registrado en este contenedor o en su padre.
   *
   * @param token - Token tipado a comprobar.
   * @returns `true` cuando el token tiene un registro asociado resoluble.
   */
  public has<TService>(token: DependencyToken<TService>): boolean {
    return this.registry.has(token as DependencyToken<never>) || (this.parent?.has(token) ?? false);
  }

  /**
   * Lista los nombres de todos los tokens registrados, en orden alfabetico.
   *
   * @returns Nombres legibles de los tokens registrados.
   */
  public listRegisteredTokens(): readonly string[] {
    return [...this.tokenNames].sort((left, right) => left.localeCompare(right));
  }

  /**
   * Construye una vista hija que hereda este contenedor como respaldo.
   * Los registros de la vista hija tienen prioridad y no contaminan al contenedor padre: es el
   * mecanismo para sustituir dependencias en pruebas automatizadas o aislar un tenant concreto.
   *
   * @returns Contenedor hijo enlazado al actual.
   */
  public createScope(): DependencyContainer {
    const child = new DependencyContainer();
    child.parent = this;
    return child;
  }

  /**
   * Verifica que un token no este registrado ya en este contenedor.
   *
   * @param token - Token tipado a comprobar.
   * @throws InternalError cuando el token ya estaba registrado.
   */
  private assertNotRegistered<TService>(token: DependencyToken<TService>): void {
    if (this.registry.has(token as DependencyToken<never>)) {
      throw new InternalError(
        `DEPENDENCIA_DUPLICADA: el token "${token.tokenName}" ya estaba registrado. ` +
          `Cada servicio se registra una sola vez; use createScope() para sustituirlo en pruebas.`
      );
    }
  }
}
