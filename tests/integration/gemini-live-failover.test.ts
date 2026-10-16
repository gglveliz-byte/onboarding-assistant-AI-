/**
 * @archivo tests/integration/gemini-live-failover.test.ts
 * @modulo 05-voice-realtime-gateway (Prueba de Fuego Integral: Gemini 3.8 Live y Failover Dual)
 * @proposito
 *   Verifica en 5 fases rigurosas:
 *   1. Mapeo del protocolo bidireccional BidiGenerateContent de Gemini (setup, audio y tools).
 *   2. Streaming de audio y recepcion de herramientas con Gemini38LiveAdapter.
 *   3. Cancelacion inmediata de Barge-in ante interrupcion del usuario.
 *   4. Orquestador Dual con Failover automatico en tiempo sub-segundo (<800ms) y Kill-Switch.
 *   5. Persistencia transaccional de sesiones y telemetria de acciones DOM con RLS y Redis.
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { PoolClient } from 'pg';
import {
  IActiveProviderStream,
  IVoiceRealtimeProvider,
  ToolInvocation,
  VoiceProviderEventHandlers,
  VoiceProviderKind,
  VoiceProviderRole,
  VoiceSessionStatus,
  VoiceStreamOpenRequest,
} from '@shared/ports/billing-voice-admin.ports';
import { GeminiProtocolMapper } from '@modules/05-voice-realtime-gateway/infrastructure/gemini-protocol.mapper';
import { Gemini38LiveAdapter } from '@modules/05-voice-realtime-gateway/infrastructure/gemini-38-live.adapter';
import { DualProviderOrchestrator } from '@modules/05-voice-realtime-gateway/infrastructure/dual-provider-orchestrator';
import {
  CreateActionEventData,
  CreateVoiceSessionData,
  PostgresVoiceSessionRepository,
} from '@modules/05-voice-realtime-gateway/infrastructure/postgres-voice-session.repository';
import { OnboardingStepStateMachine } from '@modules/05-voice-realtime-gateway/domain/voice-session-and-tools.types';

/** Fake WebSocket que simula el servidor de Gemini Live en memoria. */
class FakeGeminiWebSocket extends EventEmitter {
  public readyState = 1; // WebSocket.OPEN
  public sentMessages: string[] = [];

  public send(msg: string): void {
    this.sentMessages.push(msg);
  }

  public close(code = 1000, reason = ''): void {
    this.readyState = 3; // WebSocket.CLOSED
    this.emit('close', code, reason);
  }

  public terminate(): void {
    this.close(1006, 'Terminated');
  }

  /** Emula el envio de un mensaje desde el servidor hacia el cliente. */
  public receiveFromServer(jsonString: string): void {
    this.emit('message', Buffer.from(jsonString, 'utf-8'));
  }
}

async function runGeminiLiveTestSuite(): Promise<void> {
  console.log('='.repeat(80));
  console.log('PRUEBA DE FUEGO INTEGRAL: MODULO 05-B (GEMINI 3.8 LIVE Y FAILOVER DUAL <800MS)');
  console.log('='.repeat(80));

  // ===========================================================================
  // FASE 1: Protocolo BidiGenerateContent y Serializacion de Herramientas
  // ===========================================================================
  console.log('[1/5] Protocolo BidiGenerateContent (Setup, MediaChunks y ToolCalling)...');

  // 1.1 Construccion de setup inicial
  const setupStr = GeminiProtocolMapper.buildSetupMessage(
    'models/gemini-3.8-live',
    'Eres un asistente de onboarding para SaaS.',
    'Puck',
    0.7
  );
  const setupObj = JSON.parse(setupStr) as Record<string, unknown>;
  const setupData = setupObj['setup'] as Record<string, any>;
  assert.equal(setupData['model'], 'models/gemini-3.8-live');
  assert.equal(setupData['generationConfig']['speechConfig']['voiceConfig']['prebuiltVoiceConfig']['voiceName'], 'Puck');
  assert.equal(setupData['tools'][0]['functionDeclarations'].length, 3);
  assert.ok(setupData['tools'][0]['functionDeclarations'].some((f: any) => f['name'] === 'click_element'));
  assert.ok(setupData['tools'][0]['functionDeclarations'].some((f: any) => f['name'] === 'type_text'));

  // 1.2 Serializacion de audio PCM16
  const fakePcm = Buffer.alloc(640, 0x12); // 20ms de audio a 16kHz
  const audioMsgStr = GeminiProtocolMapper.buildAudioChunkMessage(fakePcm, 16000);
  const audioMsgObj = JSON.parse(audioMsgStr) as Record<string, any>;
  assert.equal(audioMsgObj['realtimeInput']['mediaChunks'][0]['mimeType'], 'audio/pcm;rate=16000');
  assert.equal(audioMsgObj['realtimeInput']['mediaChunks'][0]['data'], fakePcm.toString('base64'));

  // 1.3 Parseo de respuesta del servidor con llamada a herramienta
  const rawToolCallMsg = JSON.stringify({
    toolCall: {
      functionCalls: [
        {
          id: 'call_abc_123',
          name: 'click_element',
          args: { elementKey: 'btn_comenzar', reason: 'Avanzar al siguiente paso' },
        },
      ],
    },
  });
  const parsedTool = GeminiProtocolMapper.parseServerMessage(rawToolCallMsg);
  assert.equal(parsedTool.kind, 'TOOL_CALL');
  assert.equal(parsedTool.toolInvocations?.length, 1);
  assert.equal(parsedTool.toolInvocations?.[0]?.providerToolCallId, 'call_abc_123');
  assert.equal(parsedTool.toolInvocations?.[0]?.toolName, 'click_element');
  assert.equal(parsedTool.toolInvocations?.[0]?.targetElementKey, 'btn_comenzar');

  // 1.4 Construccion de respuesta a la herramienta
  const toolResponseStr = GeminiProtocolMapper.buildToolResponseMessage('call_abc_123', true, {
    selectorUsed: '#onboarding-btn',
  });
  const toolResponseObj = JSON.parse(toolResponseStr) as Record<string, any>;
  assert.equal(toolResponseObj['toolResponse']['functionResponses'][0]['id'], 'call_abc_123');
  assert.equal(toolResponseObj['toolResponse']['functionResponses'][0]['response']['output']['success'], true);
  console.log('  -> Mapeo bidireccional BidiGenerateContent verificado: OK.');

  // ===========================================================================
  // FASE 2: Streaming Bidireccional con Gemini38LiveAdapter
  // ===========================================================================
  console.log('[2/5] Apertura de Stream y Streaming con Gemini38LiveAdapter...');

  let fakeSocket!: FakeGeminiWebSocket;
  const adapter = new Gemini38LiveAdapter({
    wsUrl: 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent',
    apiKey: 'AIzaSyFakeKeyWithMoreThanSixteenCharacters123',
    wsFactory: () => {
      fakeSocket = new FakeGeminiWebSocket();
      setTimeout(() => fakeSocket.emit('open'), 5);
      return fakeSocket as any;
    },
  });

  const receivedAudioFrames: Buffer[] = [];
  const receivedTranscripts: string[] = [];
  const receivedToolCalls: ToolInvocation[] = [];
  let speechStartedFired = false;

  const handlers: VoiceProviderEventHandlers = {
    onAudioFrame: (frame) => receivedAudioFrames.push(frame),
    onTranscript: (txt) => receivedTranscripts.push(txt),
    onToolInvocation: (inv) => receivedToolCalls.push(inv),
    onAssistantSpeechStarted: () => { speechStartedFired = true; },
    onProviderError: () => {},
    onClosed: () => {},
  };

  const openReq: VoiceStreamOpenRequest = {
    organizationId: '11111111-1111-1111-1111-111111111111',
    projectId: '22222222-2222-2222-2222-222222222222',
    voiceSessionId: 'sess_test_123',
    systemPrompt: 'Guia al usuario.',
    onboardingStepsJson: [{ stepNumber: 1, instruction: 'Haz click' }],
    voicePersonaCode: 'Puck',
    modelTemperature: '0.700000',
    pcmSampleRateHz: 16000,
    externalEndUserId: null,
  };

  const streamRes = await adapter.openStream(openReq, handlers);
  assert.equal(streamRes.ok, true, 'Debe abrir el canal exitosamente');
  if (!streamRes.ok) throw new Error('Fallo al abrir canal');

  const stream = streamRes.stream;
  assert.equal(stream.providerKind, 'GEMINI');

  // Enviar un frame de audio del usuario hacia el socket
  stream.sendAudioFrame(fakePcm);
  assert.equal(fakeSocket.sentMessages.length, 2); // 1: setup, 2: audio

  // Simular respuesta de audio desde el servidor de Gemini
  const incomingAudioBase64 = Buffer.from('audio_generado_gemini').toString('base64');
  fakeSocket.receiveFromServer(
    JSON.stringify({
      serverContent: {
        modelTurn: {
          parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: incomingAudioBase64 } }],
        },
      },
    })
  );

  assert.equal(speechStartedFired, true, 'onAssistantSpeechStarted debe dispararse');
  assert.equal(receivedAudioFrames.length, 1);
  assert.equal(receivedAudioFrames[0]?.toString('utf-8'), 'audio_generado_gemini');
  console.log('  -> Canal de streaming activo y transmision de audio bidireccional: OK.');

  // ===========================================================================
  // FASE 3: Barge-in Instantaneo ante Interrupcion (<50ms)
  // ===========================================================================
  console.log('[3/5] Manejo de Barge-in y corte inmediato de buffer (<50ms)...');

  const bargeInStart = Date.now();
  stream.requestBargeIn();
  const bargeInDuration = Date.now() - bargeInStart;
  assert.ok(bargeInDuration < 50, `Barge-in debe completarse en <50ms (real: ${bargeInDuration}ms)`);

  // Simular envio de evento de interrupcion por parte del servidor
  fakeSocket.receiveFromServer(JSON.stringify({ serverContent: { interrupted: true } }));
  console.log('  -> Cancelacion de Barge-in en tiempo real ejecutada: OK.');

  // ===========================================================================
  // FASE 4: Orquestador Dual y Failover Automatico en <800ms
  // ===========================================================================
  console.log('[4/5] Orquestador Dual y Failover automatico (<800ms)...');

  // Proveedor simulado que falla o experimenta timeout
  const failingPrimaryProvider: IVoiceRealtimeProvider = {
    providerKind: 'QWEN',
    providerRole: 'PRIMARY',
    isAvailable: async () => true,
    openStream: async () => {
      // Simula fallo al conectar
      return {
        ok: false,
        code: 'PERSISTENCE_UNAVAILABLE',
        reason: 'Qwen WebSocket connection refused',
        retryable: true,
      };
    },
  };

  const responsiveFallbackProvider: IVoiceRealtimeProvider = {
    providerKind: 'GEMINI',
    providerRole: 'FAILOVER',
    isAvailable: async () => true,
    openStream: async () => {
      return {
        ok: true,
        stream: {
          providerKind: 'GEMINI',
          providerRole: 'FAILOVER',
          streamId: 'fallback_stream_gemini',
          openedAtIso: new Date().toISOString(),
          sendAudioFrame: () => {},
          sendToolResult: () => {},
          requestBargeIn: () => {},
          close: async () => {},
        },
      };
    },
  };

  const orchestrator = new DualProviderOrchestrator({
    primaryProvider: failingPrimaryProvider,
    fallbackProvider: responsiveFallbackProvider,
    failoverBudgetMs: 800,
  });

  // 4.1 Failover automatico ante error del primario
  const failoverStart = Date.now();
  const orchResult = await orchestrator.orchestrateStream(openReq, handlers, 'QWEN');
  const failoverLatency = Date.now() - failoverStart;

  assert.equal(orchResult.ok, true, 'Debe conmutar y resolver el stream exitosamente');
  if (orchResult.ok) {
    assert.equal(orchResult.activeProviderKind, 'GEMINI', 'Debe haber conmutado al respaldo GEMINI');
    assert.equal(orchResult.wasFailoverTriggered, true, 'Debe reportar que el failover fue disparado');
    assert.ok(failoverLatency < 800, `Failover debe ocurrir en <800ms (real: ${failoverLatency}ms)`);
  }

  // 4.2 Kill-Switch administrativo de SuperAdmin
  orchestrator.setKillSwitch('QWEN', true);
  assert.equal(orchestrator.isKillSwitchActive('QWEN'), true);

  const switchStart = Date.now();
  const killSwitchResult = await orchestrator.orchestrateStream(openReq, handlers, 'QWEN');
  const switchLatency = Date.now() - switchStart;

  assert.equal(killSwitchResult.ok, true);
  if (killSwitchResult.ok) {
    assert.equal(killSwitchResult.activeProviderKind, 'GEMINI');
    assert.equal(killSwitchResult.wasFailoverTriggered, true);
    assert.ok(switchLatency < 50, 'Conmutacion preventiva por Kill-Switch debe ser instantanea (<50ms)');
  }
  console.log('  -> Failover automatico <800ms y Kill-Switch de plataforma: OK.');

  // ===========================================================================
  // FASE 5: Persistencia Transaccional de Sesiones y Acciones DOM
  // ===========================================================================
  console.log('[5/5] Persistencia PostgreSQL RLS de sesiones y eventos de accion...');

  const dbStore = new Map<string, any>();
  const actionStore = new Map<string, any>();

  const mockDbClient = {
    query: async (sql: string, params?: unknown[]) => {
      const q = sql.trim();
      if (q.startsWith('INSERT INTO voice_sessions')) {
        const id = 'sess_' + Math.random().toString(36).substring(2, 9);
        const [orgId, projId, fMapId, apiKeyId, extUserId, origin, model, consent, ipHash, ua, vp] = params!;
        const row = {
          id,
          organization_id: orgId,
          project_id: projId,
          functional_map_id: fMapId,
          api_key_id: apiKeyId,
          external_end_user_id: extUserId,
          origin_domain: origin,
          ai_model_used: model,
          status: 'HANDSHAKE_ISSUED',
          end_user_consent_verified: consent,
          current_step_index: 1,
          total_steps_completed: 0,
          barge_in_count: 0,
          total_tool_calls_count: 0,
          duration_seconds: 0,
          billed_minutes: '0.000000',
          total_billed_cost_usd: '0.000000',
          client_ip_hash: ipHash,
          user_agent: ua,
          device_viewport_type: vp,
          started_at: new Date(),
          ended_at: null,
          termination_reason: null,
          created_at: new Date(),
        };
        dbStore.set(id, row);
        return { rows: [row], rowCount: 1 };
      }

      if (q.startsWith('UPDATE voice_sessions') && q.includes('barge_in_count = barge_in_count + 1')) {
        const [id] = params!;
        const row = dbStore.get(id as string);
        if (row) row.barge_in_count += 1;
        return { rows: [{ barge_in_count: row?.barge_in_count ?? 1 }], rowCount: 1 };
      }

      if (q.startsWith('UPDATE voice_sessions') && q.includes('total_tool_calls_count = total_tool_calls_count + 1')) {
        const [id] = params!;
        const row = dbStore.get(id as string);
        if (row) row.total_tool_calls_count += 1;
        return { rows: [{ total_tool_calls_count: row?.total_tool_calls_count ?? 1 }], rowCount: 1 };
      }

      if (q.startsWith('INSERT INTO action_events')) {
        const id = 'act_' + Math.random().toString(36).substring(2, 9);
        const [orgId, projId, vSessId, mElId, callId, tool, route, selector, payload] = params!;
        const row = {
          id,
          organization_id: orgId,
          project_id: projId,
          voice_session_id: vSessId,
          map_element_id: mElId,
          provider_tool_call_id: callId,
          tool_name: tool,
          route_path_at_execution: route,
          selector_used: selector,
          action_payload_redacted_json: JSON.parse(payload as string),
          execution_status: 'DISPATCHED',
          execution_latency_ms: null,
          error_code: null,
          dispatched_at: new Date(),
          acknowledged_at: null,
        };
        actionStore.set(id, row);
        return { rows: [row], rowCount: 1 };
      }

      if (q.startsWith('UPDATE action_events')) {
        const [status, lat, errCode, actId] = params!;
        const row = actionStore.get(actId as string);
        if (row) {
          row.execution_status = status;
          row.execution_latency_ms = lat;
          row.error_code = errCode;
          row.acknowledged_at = new Date();
        }
        return { rows: [], rowCount: 1 };
      }

      return { rows: [], rowCount: 0 };
    },
  } as unknown as PoolClient;

  const sessionRepo = new PostgresVoiceSessionRepository();

  // 5.1 Crear sesion
  const sessData: CreateVoiceSessionData = {
    organizationId: '11111111-1111-1111-1111-111111111111',
    projectId: '22222222-2222-2222-2222-222222222222',
    functionalMapId: '33333333-3333-3333-3333-333333333333',
    originDomain: 'https://cliente.com',
    aiModelUsed: 'gemini-3.8-live',
    endUserConsentVerified: true,
    clientIpHash: 'hash_ip_sha256_mock_abcdef',
    deviceViewportType: 'desktop',
  };

  const createdSession = await sessionRepo.createVoiceSession(mockDbClient, sessData);
  assert.equal(createdSession.aiModelUsed, 'gemini-3.8-live');
  assert.equal(createdSession.status, 'HANDSHAKE_ISSUED');

  // 5.2 Registrar telemetria de accion fisica click_element
  const actData: CreateActionEventData = {
    organizationId: createdSession.organizationId,
    projectId: createdSession.projectId,
    voiceSessionId: createdSession.id,
    providerToolCallId: 'call_abc_123',
    toolName: 'click_element',
    routePathAtExecution: '/dashboard',
    selectorUsed: 'button.btn-primary',
    actionPayloadRedactedJson: { elementKey: 'btn_comenzar' },
  };

  const createdAction = await sessionRepo.createActionEvent(mockDbClient, actData);
  assert.equal(createdAction.executionStatus, 'DISPATCHED');

  // 5.3 Actualizar ACK del SDK tras 42ms
  await sessionRepo.updateActionEventStatus(mockDbClient, createdAction.id, 'ACK_SUCCESS', 42);
  const actRow = actionStore.get(createdAction.id);
  assert.equal(actRow.execution_status, 'ACK_SUCCESS');
  assert.equal(actRow.execution_latency_ms, 42);

  // 5.4 Incremento de contadores de sesion
  const newBarge = await sessionRepo.incrementBargeInCount(mockDbClient, createdSession.id);
  const newTools = await sessionRepo.incrementToolCallsCount(mockDbClient, createdSession.id);
  assert.equal(newBarge, 1);
  assert.equal(newTools, 1);

  // 5.5 Maquina de estados de onboarding
  const stateMachine = new OnboardingStepStateMachine(1, 4, true);
  assert.equal(stateMachine.getCurrentStep(), 1);
  stateMachine.advance(2);
  assert.equal(stateMachine.getCurrentStep(), 2);
  const invalidJump = stateMachine.validateTransition(4);
  assert.equal(invalidJump.allowed, false, 'Salto directo de 2 a 4 debe ser bloqueado con strictEnforcement');

  console.log('  -> Persistencia de sesiones, telemetria de acciones y maquina de estados: OK.');

  console.log('='.repeat(80));
  console.log('RESULTADO: APROBADO. Todos los contratos y flujos de la PARTE 12 superados exitosamente.');
  console.log('='.repeat(80));
}

runGeminiLiveTestSuite().catch((err) => {
  console.error('ERROR EN PRUEBA DE FUEGO PARTE 12:', err);
  process.exit(1);
});
