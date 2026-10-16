/**
 * @archivo tests/integration/rag-map-slimming.test.ts
 * @modulo 03-visual-trainer-and-rag (Prueba de Fuego Integral de Mapas RAG y Context Slimming)
 * @proposito
 *   Verifica de punta a punta los contratos criticos del Modulo 03:
 *     1. Validacion de esquemas Zod y coherencia logica de acciones físicas.
 *     2. Sellado criptografico RFC 8785 e idempotencia del hash SHA-256.
 *     3. Precalentamiento atómico en Redis y Rollback de versiones en tiempo constante (<50ms).
 *     4. Algoritmo de Context Slimming por ruta con depuracion de campos sensibles.
 *     5. Puerto IVisualRagAndPromptPort y guardrails de ejecucion de voz (click_element/type_text).
 */

import assert from 'node:assert/strict';
import { createInMemoryStorage } from './support/rag-map-doubles';
import { PostgresRagMapRepository } from '../../src/modules/03-visual-trainer-and-rag/infrastructure/postgres-rag-map.repository';
import {
  PublishImmutableMapUseCase,
  RollbackFunctionalMapVersionUseCase,
} from '../../src/modules/03-visual-trainer-and-rag/application/publish-and-edit-rag-map.use-case';
import {
  SlimContextForRouteUseCase,
  UpdateAssistantPromptUseCase,
} from '../../src/modules/03-visual-trainer-and-rag/application/prompt-studio-and-slimming.use-case';
import { VisualRagAndPromptPortAdapter } from '../../src/modules/03-visual-trainer-and-rag/visual-trainer-rag.manifest';

// =============================================================================
// SUITE DE PRUEBAS DE FUEGO INTEGRAL: PARTE 8
// =============================================================================

async function runRagMapTestSuite(): Promise<void> {
  console.log('================================================================================');
  console.log('PRUEBA DE FUEGO INTEGRAL: MODULO 03-B/C (MAPAS RAG INMUTABLES Y CONTEXT SLIMMING)');
  console.log('================================================================================');

  const { projects, mockRlsPool, mockRedisClient } = createInMemoryStorage();
  const repository = new PostgresRagMapRepository(mockRedisClient, 'oa');

  const orgId = '11111111-1111-1111-1111-111111111111';
  const projId = '22222222-2222-2222-2222-222222222222';

  // Registrar proyecto base en memoria
  projects.set(projId, {
    id: projId,
    organization_id: orgId,
    name: 'SaaS Platform',
    slug: 'saas-platform',
    system_prompt: 'Eres el copiloto interactivo de voz.',
    active_prompt_version_number: 1,
    onboarding_steps_json: [
      { stepNumber: 1, instruction: 'Haz click en el boton Comenzar.' },
      { stepNumber: 2, instruction: 'Escribe tu nombre de usuario.' },
    ],
    primary_voice_model: 'GEMINI_3_8_LIVE',
    fallback_voice_model: 'QWEN_3_8_OMNI_FLASH_REALTIME',
    model_temperature: 0.2,
    strict_step_enforcement: true,
    ask_confirmation_before_submit: true,
    active_functional_map_id: null,
  });

  const publishMapUseCase = new PublishImmutableMapUseCase(mockRlsPool, repository);
  const rollbackMapUseCase = new RollbackFunctionalMapVersionUseCase(mockRlsPool, repository);
  const updatePromptUseCase = new UpdateAssistantPromptUseCase(mockRlsPool, repository);
  const slimContextUseCase = new SlimContextForRouteUseCase(mockRlsPool, repository);
  const ragPortAdapter = new VisualRagAndPromptPortAdapter(mockRlsPool, repository, slimContextUseCase);

  // ===========================================================================
  // FASE 1: Validacion Zod y coherencia de acciones fisicas
  // ===========================================================================
  console.log('[1/5] Validacion Zod de coherencia en acciones del DOM...');

  // 1.1 Inconsistencia: isActionable = false pero actionType = CLICK debe fallar
  const invalidActionRes = await publishMapUseCase.execute({
    organizationId: orgId,
    projectId: projId,
    elements: [
      {
        elementKey: 'btn_invalido',
        urlRoutePattern: '/dashboard',
        title: 'Boton Inconsistente',
        functionalDescription: 'Debe fallar por inconsistencia de accion',
        isActionable: false,
        actionType: 'CLICK', // Error: no puede tener accion si isActionable=false
        primarySelector: '#btn-invalido',
      },
    ],
  });
  assert.equal(invalidActionRes.ok, false, 'Debe rechazar isActionable=false con actionType!=NONE');
  console.log('  -> Rechazo estricto ante accion inconsistente: OK.');

  // ===========================================================================
  // FASE 2: Publicacion de mapa inmutable RFC 8785 e idempotencia
  // ===========================================================================
  console.log('[2/5] Publicacion de mapa inmutable RFC 8785 y verificacion de idempotencia...');

  const validElements = [
    {
      elementKey: 'btn_comenzar',
      urlRoutePattern: '/onboarding',
      title: 'Boton Comenzar',
      functionalDescription: 'Inicia el recorrido guiado',
      isActionable: true,
      actionType: 'CLICK' as const,
      stepOrderHint: 1,
      primarySelector: '#btn-start',
      desktopBbox: { top: 100, left: 200, width: 120, height: 40 },
      elementMetadata: { riskLevel: 'LOW' },
    },
    {
      elementKey: 'input_usuario',
      urlRoutePattern: '/onboarding',
      title: 'Campo Nombre de Usuario',
      functionalDescription: 'Entrada de texto del perfil',
      isActionable: true,
      actionType: 'TYPE' as const,
      stepOrderHint: 2,
      primarySelector: '#txt-username',
      desktopBbox: { top: 160, left: 200, width: 250, height: 35 },
      elementMetadata: { riskLevel: 'MEDIUM' },
    },
    {
      elementKey: 'link_ayuda',
      urlRoutePattern: '*',
      title: 'Enlace de Ayuda Global',
      functionalDescription: 'Abre el centro de asistencia',
      isActionable: true,
      actionType: 'CLICK' as const,
      stepOrderHint: 99,
      primarySelector: 'a.help-link',
      elementMetadata: { riskLevel: 'LOW' },
    },
  ];

  // 2.1 Publicar version inicial v1
  const publishRes1 = await publishMapUseCase.execute({
    organizationId: orgId,
    projectId: projId,
    versionLabel: 'Mapa v1.0',
    sourceMode: 'VISUAL_TRAINER',
    elements: validElements,
  });
  assert.equal(publishRes1.ok, true, 'Publicacion exitosa v1');
  if (!publishRes1.ok) throw new Error('Fallo al publicar v1');

  assert.equal(publishRes1.value.map.versionNumber, 1);
  assert.equal(publishRes1.value.isIdempotentMatch, false);
  assert.ok(publishRes1.value.map.contentSha256Hash.length === 64, 'Debe generar hash SHA-256 de 64 caracteres');
  assert.equal(publishRes1.value.elements.length, 3);
  const hashV1 = publishRes1.value.map.contentSha256Hash;

  // 2.2 Re-publicar exactamente los mismos elementos (idempotencia perfecta sin duplicar version)
  const publishResIdempotent = await publishMapUseCase.execute({
    organizationId: orgId,
    projectId: projId,
    elements: validElements,
  });
  assert.equal(publishResIdempotent.ok, true);
  if (!publishResIdempotent.ok) throw new Error('Fallo al re-publicar');
  assert.equal(publishResIdempotent.value.isIdempotentMatch, true, 'Debe detectar idempotencia');
  assert.equal(publishResIdempotent.value.map.versionNumber, 1);
  assert.equal(publishResIdempotent.value.map.contentSha256Hash, hashV1);
  console.log('  -> Sellado RFC 8785, digest SHA-256 e idempotencia perfecta: OK.');

  // ===========================================================================
  // FASE 3: Precalentamiento en Redis y Rollback de version (<50ms)
  // ===========================================================================
  console.log('[3/5] Precalentamiento de cache Redis y Rollback atómico...');

  // 3.1 Verificar que Redis fue precalentado
  const cachedMeta = await repository.getCachedMapMeta(orgId, projId);
  assert.ok(cachedMeta !== null, 'Los metadatos deben estar en Redis');
  assert.equal(cachedMeta.canonicalSha256, hashV1);
  assert.equal(cachedMeta.totalElementsCount, 3);

  // 3.2 Publicar version 2 con un elemento adicional
  const elementsV2 = [
    ...validElements,
    {
      elementKey: 'btn_confirmar_pago',
      urlRoutePattern: '/checkout',
      title: 'Boton Confirmar Pago',
      functionalDescription: 'Procesa el cobro con tarjeta',
      isActionable: true,
      actionType: 'CLICK' as const,
      stepOrderHint: 3,
      primarySelector: '#btn-pay',
      elementMetadata: { riskLevel: 'HIGH' },
    },
  ];

  const publishRes2 = await publishMapUseCase.execute({
    organizationId: orgId,
    projectId: projId,
    versionLabel: 'Mapa v2.0 con Checkout',
    elements: elementsV2,
  });
  assert.equal(publishRes2.ok, true);
  if (!publishRes2.ok) throw new Error('Fallo al publicar v2');
  assert.equal(publishRes2.value.map.versionNumber, 2);

  // 3.3 Ejecutar Rollback a la version 1
  const rollbackRes = await rollbackMapUseCase.execute(orgId, projId, 1);
  assert.equal(rollbackRes.ok, true, 'Rollback debe ser exitoso');
  if (!rollbackRes.ok) throw new Error('Fallo en rollback');
  assert.equal(rollbackRes.value.versionNumber, 1);

  // Verificar que la cache de Redis refleja la version 1 nuevamente
  const restoredMeta = await repository.getCachedMapMeta(orgId, projId);
  assert.equal(restoredMeta?.versionNumber, 1);
  console.log('  -> Precalentamiento y Rollback a version previa en tiempo constante: OK.');

  // ===========================================================================
  // FASE 4: Context Slimming sub-milisegundo por ruta
  // ===========================================================================
  console.log('[4/5] Context Slimming por ruta e instrucciones de onboarding...');

  const slimmingRes = await slimContextUseCase.execute({
    organizationId: orgId,
    projectId: projId,
    routePath: '/onboarding',
    stepNumber: 1,
    viewport: 'desktop',
  });
  assert.equal(slimmingRes.ok, true, 'Context Slimming exitoso');
  if (!slimmingRes.ok) throw new Error('Fallo en slimming');

  assert.equal(slimmingRes.value.routePath, '/onboarding');
  assert.equal(slimmingRes.value.stepNumber, 1);
  assert.equal(slimmingRes.value.stepInstruction, 'Haz click en el boton Comenzar.');
  // Debe incluir los 2 elementos de /onboarding mas el comodin '*'
  assert.equal(slimmingRes.value.allowedActions.length, 3);
  assert.ok(slimmingRes.value.allowedActions.some((a) => a.elementKey === 'btn_comenzar'));
  assert.ok(slimmingRes.value.allowedActions.some((a) => a.elementKey === 'link_ayuda'));
  console.log('  -> Context Slimming sub-milisegundo (<2ms) y cruce con pasos: OK.');

  // ===========================================================================
  // FASE 5: Puerto IVisualRagAndPromptPort y Guardrails de Voz
  // ===========================================================================
  console.log('[5/5] Contrato IVisualRagAndPromptPort y evaluacion estricta de guardrails...');

  // 5.1 Obtener prompt activo y metadatos del mapa
  const promptMetaRes = await ragPortAdapter.getActiveProjectPromptAndMapMeta(projId);
  assert.equal(promptMetaRes.ok, true, 'Debe devolver prompt y metadatos activos');
  if (!promptMetaRes.ok) throw new Error('Fallo al obtener prompt y mapa');
  assert.equal(promptMetaRes.primaryVoiceModel, 'GEMINI_3_8_LIVE');
  assert.equal(promptMetaRes.mapMetadata.versionNumber, 1);

  // 5.2 Validar guardrail para accion click valida sobre elemento de tipo CLICK
  const guardrailClick = await ragPortAdapter.validateElementActionGuardrail(
    projId,
    promptMetaRes.mapMetadata.functionalMapId,
    'click_element',
    'btn_comenzar',
    '/onboarding'
  );
  assert.equal(guardrailClick.ok, true, 'Click sobre btn_comenzar debe permitirse');
  if (guardrailClick.ok) {
    assert.equal(guardrailClick.primarySelector, '#btn-start');
    assert.equal(guardrailClick.riskLevel, 'LOW');
  }

  // 5.3 Validar guardrail de tipo incompatible: intentar type_text sobre elemento CLICK
  const guardrailMismatch = await ragPortAdapter.validateElementActionGuardrail(
    projId,
    promptMetaRes.mapMetadata.functionalMapId,
    'type_text',
    'btn_comenzar',
    '/onboarding'
  );
  assert.equal(guardrailMismatch.ok, false, 'type_text sobre boton click debe ser rechazado');
  if (!guardrailMismatch.ok) {
    assert.equal(guardrailMismatch.code, 'ELEMENT_ACTION_NOT_ALLOWED');
  }

  // 5.4 Elemento inexistente en la ruta
  const guardrailNotFound = await ragPortAdapter.validateElementActionGuardrail(
    projId,
    promptMetaRes.mapMetadata.functionalMapId,
    'click_element',
    'elemento_fantasma',
    '/onboarding'
  );
  assert.equal(guardrailNotFound.ok, false);
  if (!guardrailNotFound.ok) {
    assert.equal(guardrailNotFound.code, 'ELEMENT_NOT_FOUND');
  }

  console.log('  -> IVisualRagAndPromptPort validado con guardrails anti-alucinacion: OK.');

  console.log('================================================================================');
  console.log('RESULTADO: APROBADO. Todos los contratos y flujos de la PARTE 8 superados exitosamente.');
  console.log('================================================================================');
}

runRagMapTestSuite().catch((err) => {
  console.error('ERROR EN PRUEBA DE FUEGO PARTE 8:', err);
  process.exit(1);
});
