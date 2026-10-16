/**
 * @archivo tests/unit/voice-session-caps.test.ts
 * @modulo 05-voice-realtime-gateway (Prueba de Topes de Concurrencia de Sesiones Vivas C1-59)
 * @proposito
 *   Demuestra y mide que el registro de sesiones del pool de voz hace cumplir de forma estricta:
 *   1. El tope maximo de sesiones simultaneas por organizacion (maxSessionsPerOrg).
 *   2. El tope global de sesiones en el nodo de sockets (maxGlobalSessions).
 *   3. El rechazo explicito con codigo de cierre 4007 (RATE_LIMITED) al superarse los limites.
 */

import assert from 'node:assert/strict';
import { VoicePoolSessionRegistry } from '../../src/bootstrap/voice-pool-session-registry';
import { VOICE_CLOSE_CODES } from '../../src/modules/05-voice-realtime-gateway/infrastructure/voice-frame.protocol';

console.log('================================================================================');
console.log('PRUEBA DE TOPES DE SESIONES SIMULTANEAS: POR ORGANIZACION Y GLOBAL (C1-59)');
console.log('================================================================================');

async function runSessionCapsSuite(): Promise<void> {
  const registry = new VoicePoolSessionRegistry({
    maxSessionsPerOrg: 5,
    maxGlobalSessions: 12,
  });

  const orgA = 'org-1111-aaaa';
  const orgB = 'org-2222-bbbb';
  const orgC = 'org-3333-cccc';

  // 1. Simular registro de 5 sesiones para orgA
  for (let i = 1; i <= 5; i++) {
    const check = registry.canAcceptSession(orgA);
    assert.equal(check.allowed, true, `Sesion ${i} de orgA debe ser aceptada`);
    registry.add({
      organizationId: orgA,
      voiceSessionId: `sess-a-${i}`,
      session: { isSessionOpen: () => true, close: async () => {} } as any,
      socket: { readyState: 1, close: () => {}, terminate: () => {} } as any,
      openedAtMs: Date.now(),
    });
  }

  assert.equal(registry.countForOrg(orgA), 5, 'orgA debe tener exactamente 5 sesiones');
  assert.equal(registry.count(), 5, 'Total global debe ser 5');

  // 2. Intentar sesion 6 para orgA -> DEBE RECHAZARSE por tope de organizacion
  const rejectedOrgA = registry.canAcceptSession(orgA);
  assert.equal(rejectedOrgA.allowed, false, 'Sesion 6 de orgA debe ser rechazada');
  assert.equal(rejectedOrgA.closeCode, VOICE_CLOSE_CODES.RATE_LIMITED, 'Codigo debe ser 4007 RATE_LIMITED');
  assert.match(rejectedOrgA.reason ?? '', /su organizacion/i, 'Motivo debe indicar limite de organizacion');
  console.log('  -> Rechazo por tope de organizacion (5/5 sesiones activas): OK (Codigo 4007)');

  // 3. Otra organizacion (orgB) aun tiene cupo y debe ser admitida
  for (let i = 1; i <= 5; i++) {
    const check = registry.canAcceptSession(orgB);
    assert.equal(check.allowed, true, `Sesion ${i} de orgB debe ser aceptada`);
    registry.add({
      organizationId: orgB,
      voiceSessionId: `sess-b-${i}`,
      session: { isSessionOpen: () => true, close: async () => {} } as any,
      socket: { readyState: 1, close: () => {}, terminate: () => {} } as any,
      openedAtMs: Date.now(),
    });
  }
  assert.equal(registry.countForOrg(orgB), 5);
  assert.equal(registry.count(), 10, 'Total global debe ser 10');

  // 4. Llenar hasta el tope global (maxGlobalSessions = 12) usando orgC
  for (let i = 1; i <= 2; i++) {
    const check = registry.canAcceptSession(orgC);
    assert.equal(check.allowed, true);
    registry.add({
      organizationId: orgC,
      voiceSessionId: `sess-c-${i}`,
      session: { isSessionOpen: () => true, close: async () => {} } as any,
      socket: { readyState: 1, close: () => {}, terminate: () => {} } as any,
      openedAtMs: Date.now(),
    });
  }
  assert.equal(registry.count(), 12, 'Total global llego al tope maximo de 12');

  // 5. Intentar cualquier sesion adicional -> DEBE RECHAZARSE por tope global
  const rejectedGlobal = registry.canAcceptSession(orgC);
  assert.equal(rejectedGlobal.allowed, false, 'Cualquier sesion debe ser rechazada por tope global');
  assert.equal(rejectedGlobal.closeCode, VOICE_CLOSE_CODES.RATE_LIMITED, 'Codigo debe ser 4007 RATE_LIMITED');
  assert.match(rejectedGlobal.reason ?? '', /limite global/i, 'Motivo debe indicar limite global');
  console.log('  -> Rechazo por tope global (12/12 sesiones activas en el nodo): OK (Codigo 4007)');

  // 6. Cerrar una sesion y verificar que se libera el cupo
  registry.remove('sess-a-1');
  assert.equal(registry.countForOrg(orgA), 4);
  assert.equal(registry.count(), 11);
  const nowAllowedOrgA = registry.canAcceptSession(orgA);
  assert.equal(nowAllowedOrgA.allowed, true, 'Tras liberar sesion, orgA puede abrir otra');
  console.log('  -> Liberacion dinamica de cupo tras cierre de sesion: OK');

  console.log('================================================================================');
  console.log('RESULTADO: APROBADO. Topes de sesiones simultaneas verificados al 100%.');
  console.log('================================================================================');
}

runSessionCapsSuite().catch((err) => {
  console.error(err);
  process.exit(1);
});
