/**
 * @archivo apps/web/src/components/landing/live-demo/VortexCrmSimulatorBoard.tsx
 * @modulo apps/web/src/components/landing/live-demo (Lienzo Interactivo de CRM Simulado)
 * @proposito
 *   Lienzo visual e interactivo de CRM ("Vortex CRM") ultra-compacto y 100% funcional:
 *   soporta interacción física manual por el usuario (tecleo en inputs, cambio de etapa en selects,
 *   creación y guardado de tratos reales en la tabla, navegación a facturación y validación CFDI)
 *   y ejecución programática dirigida por el asistente de voz a través del contrato `CrmBoardHandle`
 *   (`prepareDirective`, `commitDirective`, `resolveAnchorViewportCenter`).
 *
 * @resumen_contenido
 *   - `CrmBoardHandle`: Contrato para la orquestación del cursor bioluminiscente y acuse de directivas.
 *   - Tabla de pipeline reactiva: insertar nuevos tratos en tiempo real con animación.
 *   - Formulario de trato con inputs nativos y setters compatibles con React 19.
 *   - Pestaña de facturación interactiva con validación fiscal CFDI y chipslot.
 *   - Widget inferior de ecualizador reactivo a la energía real del micrófono (`barsEnergy`).
 *
 * @dependencias_internas
 *   - `../../../lib/api-client/backend-contracts.types` (`ToolExecuteMessageDto`).
 *
 * @dependencias_externas
 *   - `react` (`useState`, `useRef`, `useImperativeHandle`, `forwardRef`, type `ReactElement`).
 */

'use client';

import {
  forwardRef,
  useImperativeHandle,
  useRef,
  useState,
  type FormEvent,
  type ReactElement,
} from 'react';
import type { ToolExecuteMessageDto } from '../../../lib/api-client/backend-contracts.types';
import { VortexCrmVoiceBar } from './VortexCrmVoiceBar';
import { VortexCrmBillingPanel } from './VortexCrmBillingPanel';

/** Fila del pipeline de ventas */
interface DealRow {
  readonly id: string;
  readonly name: string;
  readonly stage: string;
  readonly value: string;
  readonly contact: string;
  readonly date: string;
  readonly isNew?: boolean;
}

/** Contrato para interactuar programáticamente con el tablero desde la demo de voz */
export interface CrmBoardHandle {
  prepareDirective(directive: ToolExecuteMessageDto): void;
  commitDirective(directive: ToolExecuteMessageDto): { readonly success: boolean; readonly detail: string | null };
  resolveAnchorViewportCenter(anchorKey: string): { readonly xNorm: number; readonly yNorm: number } | null;
  resetBoard(): void;
}

export interface VortexCrmSimulatorBoardProps {
  readonly phase?: string;
  readonly isRunning?: boolean;
  readonly barsEnergy?: readonly number[];
  readonly speechText?: string;
}

const INITIAL_DEALS: readonly DealRow[] = [
  { id: '1', name: 'SaaS Cloud Migration', stage: 'Cerrado ganado', value: '$64,000', contact: 'sofia@techcorp.io', date: '12 May' },
  { id: '2', name: 'Fintech API Integration', stage: 'Negociación', value: '$42,500', contact: 'carlos@finpay.co', date: '28 May' },
];

export const VortexCrmSimulatorBoard = forwardRef<CrmBoardHandle, VortexCrmSimulatorBoardProps>(
  function VortexCrmSimulatorBoard({ phase = 'IDLE', isRunning = false, barsEnergy = [], speechText = '' }, ref): ReactElement {
    const isSpeaking = phase === 'AI_SPEAKING';
    const isExecuting = phase === 'EXECUTING_DOM_ACTION';

    const containerRef = useRef<HTMLDivElement | null>(null);
    const inputDealNameRef = useRef<HTMLInputElement | null>(null);
    const inputCompanyRef = useRef<HTMLInputElement | null>(null);
    const inputDealValueRef = useRef<HTMLInputElement | null>(null);
    const selectStageRef = useRef<HTMLSelectElement | null>(null);

    // Estados del CRM interactivo
    const [deals, setDeals] = useState<readonly DealRow[]>(INITIAL_DEALS);
    const [activeTab, setActiveTab] = useState<'deals' | 'billing'>('deals');
    const [dealName, setDealName] = useState('Acuerdo Enterprise Q3');
    const [companyName, setCompanyName] = useState('Acme Corp');
    const [dealValue, setDealValue] = useState('$35,000 USD');
    const [selectedStage, setSelectedStage] = useState('Negociación');
    const [isFormOpen, setIsFormOpen] = useState(true);
    const [cfdiValidated, setCfdiValidated] = useState(false);
    const [inspectedKey, setInspectedKey] = useState<string | null>(null);

    // Escribir texto nativo saltando trampas de React
    const injectText = (input: HTMLInputElement | null, text: string, setter: (val: string) => void): void => {
      if (!input) return;
      const proto = window.HTMLInputElement?.prototype;
      const nativeSetter = proto ? Object.getOwnPropertyDescriptor(proto, 'value')?.set : undefined;
      if (nativeSetter) {
        nativeSetter.call(input, text);
      } else {
        input.value = text;
      }
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      setter(text);
    };

    // Guardar trato en la tabla
    const handleSaveDeal = (): void => {
      const finalName = dealName.trim().length > 0 ? dealName.trim() : 'Nuevo Trato Sin Título';
      const newRow: DealRow = {
        id: `deal_${Date.now()}`,
        name: finalName,
        stage: selectedStage,
        value: dealValue.trim().length > 0 ? dealValue.trim() : '$10,000 USD',
        contact: 'asistente@onboarding.ai',
        date: 'Ahora',
        isNew: true,
      };
      setDeals((prev) => [newRow, ...prev.slice(0, 3)]);
      setDealName('');
    };

    // Resolver ancla en el contenedor
    const findAnchorElement = (key: string): HTMLElement | null => {
      if (!containerRef.current) return null;
      const cleanKey = key.replace(/^demo-/, '');
      return (
        containerRef.current.querySelector<HTMLElement>(`[data-oa-id="${key}"]`) ??
        containerRef.current.querySelector<HTMLElement>(`[data-oa-id="${cleanKey}"]`) ??
        containerRef.current.querySelector<HTMLElement>(`[data-oa-id="demo-${cleanKey}"]`) ??
        containerRef.current.querySelector<HTMLElement>(`#${cleanKey}`)
      );
    };

    // Exponer API del tablero para la IA y cursor
    useImperativeHandle(ref, () => ({
      prepareDirective(directive: ToolExecuteMessageDto): void {
        setInspectedKey(directive.targetElementKey);
        const el = findAnchorElement(directive.targetElementKey);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      },
      commitDirective(directive: ToolExecuteMessageDto): { success: boolean; detail: string | null } {
        setInspectedKey(null);
        const normKey = directive.targetElementKey.replace(/^demo-/, '');

        if (directive.toolName === 'type_text' && directive.textPayload !== null) {
          if (normKey.includes('tax') || normKey.includes('company')) {
            injectText(inputCompanyRef.current, directive.textPayload, setCompanyName);
            return { success: true, detail: `Empresa "${directive.textPayload}" capturada.` };
          }
          if (normKey.includes('value')) {
            injectText(inputDealValueRef.current, directive.textPayload, setDealValue);
            return { success: true, detail: `Valor "${directive.textPayload}" asignado.` };
          }
          injectText(inputDealNameRef.current, directive.textPayload, setDealName);
          return { success: true, detail: `Trato "${directive.textPayload}" capturado.` };
        }

        switch (normKey) {
          case 'btn-new-deal':
            setIsFormOpen(true);
            setActiveTab('deals');
            setDealName('');
            inputDealNameRef.current?.focus();
            return { success: true, detail: 'Formulario de trato abierto y limpio.' };
          case 'btn-save-deal':
            handleSaveDeal();
            return { success: true, detail: 'Trato guardado exitosamente en el pipeline.' };
          case 'nav-billing':
            setActiveTab('billing');
            return { success: true, detail: 'Sección Facturación activada.' };
          case 'btn-validate-cfdi':
            setCfdiValidated(true);
            return { success: true, detail: 'Comprobante fiscal CFDI validado.' };
          default: {
            const el = findAnchorElement(directive.targetElementKey);
            if (el) {
              el.click();
              return { success: true, detail: `Clic ejecutado en ${directive.targetElementKey}.` };
            }
            return { success: true, detail: `Acción física procesada sobre ${directive.targetElementKey}.` };
          }
        }
      },
      resolveAnchorViewportCenter(anchorKey: string): { xNorm: number; yNorm: number } | null {
        if (!containerRef.current) return null;
        const target = findAnchorElement(anchorKey);
        if (!target) return null;
        const hostRect = containerRef.current.getBoundingClientRect();
        const targetRect = target.getBoundingClientRect();
        const relX = targetRect.left + targetRect.width / 2 - hostRect.left;
        const relY = targetRect.top + targetRect.height / 2 - hostRect.top;
        return {
          xNorm: Math.min(1, Math.max(0, relX / Math.max(1, hostRect.width))),
          yNorm: Math.min(1, Math.max(0, relY / Math.max(1, hostRect.height))),
        };
      },
      resetBoard(): void {
        setInspectedKey(null);
        setDeals(INITIAL_DEALS);
        setActiveTab('deals');
        setIsFormOpen(true);
        setCfdiValidated(false);
        setDealName('Acuerdo Enterprise Q3');
      },
    }));

    return (
      <div
        ref={containerRef}
        className="relative bg-slate-50 min-h-[320px] h-[330px] md:h-[355px] lg:h-[375px] flex flex-col md:flex-row overflow-hidden"
        data-purpose="crm-screen-viewport"
      >
        {/* Barra lateral interactiva (desktop >= lg) */}
        <div className="hidden lg:flex w-44 xl:w-48 flex-col border-r border-slate-200 bg-white p-2.5 justify-between shrink-0">
          <div className="space-y-3">
            <div className="flex items-center gap-2 px-1">
              <div className="w-6 h-6 rounded-md bg-gradient-to-tr from-[#6d3dfa] to-[#0ea5e9] flex items-center justify-center text-white text-[10px] font-bold shadow-xs">
                OA
              </div>
              <span className="font-bold text-xs text-[#0a252c] tracking-tight">Vortex CRM</span>
            </div>

            <nav className="space-y-0.5 text-[11px] font-semibold">
              <button
                type="button"
                data-oa-id="nav-deals"
                onClick={() => setActiveTab('deals')}
                className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-left transition-colors cursor-pointer ${
                  activeTab === 'deals' ? 'bg-teal-50 text-[#00838f] font-bold' : 'text-slate-600 hover:bg-slate-50'
                }`}
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                  <circle cx="9" cy="7" r="4" />
                </svg>
                <span>Tratos / Deals</span>
              </button>
              <button
                type="button"
                data-oa-id="nav-billing"
                onClick={() => setActiveTab('billing')}
                className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-left transition-colors cursor-pointer ${
                  activeTab === 'billing' ? 'bg-teal-50 text-[#00838f] font-bold' : 'text-slate-600 hover:bg-slate-50'
                }`}
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <rect height="14" rx="2" width="20" x="2" y="5" />
                  <line x1="2" x2="22" y1="10" y2="10" />
                </svg>
                <span>Facturación</span>
              </button>
            </nav>
          </div>

          <div className="border-t border-slate-100 pt-2 flex items-center gap-2 px-1">
            <div className="w-5 h-5 rounded-full bg-slate-200 flex items-center justify-center text-[9px] font-bold text-slate-600">
              MR
            </div>
            <div className="truncate text-[10px]">
              <p className="font-semibold text-slate-800 leading-tight">Marcos R.</p>
              <p className="text-[9px] text-slate-400">Head of Sales</p>
            </div>
          </div>
        </div>

        {/* Tablero principal del CRM */}
        <div className="flex-1 p-2.5 sm:p-3 lg:p-3.5 flex flex-col min-h-0 min-w-0">
          <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
            {/* Cabecera del tablero */}
            <div className="flex items-center justify-between gap-2 mb-2 flex-wrap sm:flex-nowrap">
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-xs sm:text-sm font-bold text-[#0a252c] leading-tight">
                    {activeTab === 'deals' ? 'Pipeline de Ventas Global' : 'Módulo Facturación y CFDI'}
                  </h3>
                  {/* Selector rápido móvil (< lg) */}
                  <div className="flex lg:hidden items-center bg-slate-200/80 p-0.5 rounded text-[9px] font-semibold">
                    <button
                      type="button"
                      onClick={() => setActiveTab('deals')}
                      className={`px-1.5 py-0.5 rounded transition ${activeTab === 'deals' ? 'bg-white text-teal-800 font-bold shadow-xs' : 'text-slate-600'}`}
                    >
                      Tratos
                    </button>
                    <button
                      type="button"
                      onClick={() => setActiveTab('billing')}
                      className={`px-1.5 py-0.5 rounded transition ${activeTab === 'billing' ? 'bg-white text-teal-800 font-bold shadow-xs' : 'text-slate-600'}`}
                    >
                      Factura
                    </button>
                  </div>
                </div>
                <p className="text-[10px] text-slate-400">
                  {activeTab === 'deals' ? `${deals.length + 30} tratos activos · $542,000 USD` : 'Comprobantes fiscales y RFC'}
                </p>
              </div>
              <div className="flex items-center gap-1.5">
                {activeTab === 'deals' ? (
                  <>
                    <button
                      type="button"
                      data-oa-id="btn-new-deal"
                      onClick={() => {
                        setIsFormOpen(true);
                        setDealName('');
                        inputDealNameRef.current?.focus();
                      }}
                      className={`text-[10px] font-semibold px-2.5 py-1 rounded-md flex items-center gap-1 shadow-xs transition-all cursor-pointer ${
                        inspectedKey === 'btn-new-deal'
                          ? 'ring-2 ring-teal-400 bg-teal-600 text-white'
                          : 'bg-[#0a252c] hover:bg-slate-800 text-white'
                      }`}
                    >
                      <span>+</span> Nuevo Trato
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    data-oa-id="btn-validate-cfdi"
                    onClick={() => setCfdiValidated(true)}
                    className="bg-[#6d3dfa] hover:bg-[#5c2ee0] text-white text-[10px] font-semibold px-2.5 py-1 rounded-md transition-colors cursor-pointer"
                  >
                    Validar CFDI
                  </button>
                )}
              </div>
            </div>

            {/* Vista 1: Tabla de tratos interactiva */}
            {activeTab === 'deals' ? (
              <>
                <div className="bg-white rounded-lg border border-slate-200/90 shadow-xs overflow-x-auto mb-2">
                  <table className="w-full text-left text-[11px] text-slate-600 border-collapse min-w-[360px]">
                    <thead>
                      <tr className="bg-slate-50/90 border-b border-slate-200 text-slate-400 font-medium text-[9px] sm:text-[10px]">
                        <th className="py-1 px-2.5">NOMBRE DEL TRATO</th>
                        <th className="py-1 px-2.5">ETAPA</th>
                        <th className="py-1 px-2.5">VALOR</th>
                        <th className="py-1 px-2.5 text-right">CIERRE</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 text-[10px] sm:text-[11px]">
                      {deals.map((deal) => (
                        <tr key={deal.id} className={deal.isNew ? 'bg-teal-50/60 font-semibold' : 'hover:bg-slate-50/60'}>
                          <td className="py-1 px-2.5 font-semibold text-slate-800 flex items-center gap-1.5">
                            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${deal.isNew ? 'bg-[#6d3dfa] animate-ping' : 'bg-emerald-500'}`} />
                            <span className="truncate max-w-[130px] sm:max-w-none">{deal.name}</span>
                          </td>
                          <td className="py-1 px-2.5">
                            <span className="px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-800 text-[9px] font-semibold">
                              {deal.stage}
                            </span>
                          </td>
                          <td className="py-1 px-2.5 font-mono font-bold text-slate-800">{deal.value}</td>
                          <td className="py-1 px-2.5 text-right text-slate-400 text-[10px]">{deal.date}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Diálogo/Formulario interactivo real */}
                {isFormOpen && (
                  <form
                    onSubmit={(e: FormEvent) => {
                      e.preventDefault();
                      handleSaveDeal();
                    }}
                    className="relative bg-white rounded-lg border border-[#6d3dfa]/40 p-2 sm:p-2.5 shadow-md ring-1 ring-[#6d3dfa]/20"
                    data-purpose="ai-live-execution-dialog"
                  >
                    <div className="flex items-center justify-between border-b border-slate-100 pb-1 mb-1.5">
                      <div className="flex items-center gap-1.5">
                        <span className="w-2 h-2 rounded-full bg-[#6d3dfa] animate-ping" />
                        <span className="text-[10px] sm:text-[11px] font-bold text-[#6d3dfa] uppercase tracking-wide">
                          {isExecuting ? 'IA Ejecutando en Pantalla' : 'Formulario de Trato Activo'}
                        </span>
                      </div>
                      <button
                        type="button"
                        data-oa-id="btn-save-deal"
                        onClick={handleSaveDeal}
                        className={`text-[9px] font-bold px-2 py-0.5 rounded shadow-xs transition-all cursor-pointer ${
                          inspectedKey === 'btn-save-deal'
                            ? 'bg-emerald-500 text-white ring-2 ring-emerald-300'
                            : 'bg-[#6d3dfa] text-white hover:bg-[#5c2ee0]'
                        }`}
                      >
                        ✓ Guardar trato
                      </button>
                    </div>

                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 text-[11px]">
                      <div>
                        <label htmlFor="input-deal-name" className="block text-slate-500 font-medium mb-0.5 text-[9px] sm:text-[10px]">
                          Nombre del Trato
                        </label>
                        <input
                          ref={inputDealNameRef}
                          id="input-deal-name"
                          type="text"
                          data-oa-id="demo-input-deal-name"
                          value={dealName}
                          onChange={(e) => setDealName(e.target.value)}
                          placeholder="Ej: Contrato Enterprise"
                          className={`w-full bg-violet-50/70 border rounded px-1.5 py-1 min-h-[30px] text-[10px] sm:text-[11px] font-semibold text-slate-900 focus:outline-none ${
                            inspectedKey === 'input-deal-name' || inspectedKey === 'demo-input-deal-name'
                              ? 'border-teal-400 ring-2 ring-teal-300'
                              : 'border-[#6d3dfa]/60 focus:border-[#6d3dfa]'
                          }`}
                        />
                      </div>
                      <div>
                        <label htmlFor="input-company-tax" className="block text-slate-500 font-medium mb-0.5 text-[9px] sm:text-[10px]">
                          Empresa / RFC
                        </label>
                        <input
                          ref={inputCompanyRef}
                          id="input-company-tax"
                          type="text"
                          data-oa-id="input-company-tax"
                          value={companyName}
                          onChange={(e) => setCompanyName(e.target.value)}
                          placeholder="Empresa o RFC"
                          className="w-full bg-slate-50 border border-slate-200 rounded px-1.5 py-1 min-h-[30px] text-[10px] sm:text-[11px] text-slate-800 font-medium focus:outline-none focus:border-teal-500"
                        />
                      </div>
                      <div>
                        <label htmlFor="select-deal-stage" className="block text-slate-500 font-medium mb-0.5 text-[9px] sm:text-[10px]">
                          Etapa
                        </label>
                        <select
                          ref={selectStageRef}
                          id="select-deal-stage"
                          data-oa-id="demo-select-stage"
                          value={selectedStage}
                          onChange={(e) => setSelectedStage(e.target.value)}
                          className="w-full bg-slate-50 border border-slate-200 rounded px-1.5 py-1 min-h-[30px] text-[10px] sm:text-[11px] text-slate-700 font-medium focus:outline-none focus:border-teal-500"
                        >
                          <option value="Prospección">Prospección</option>
                          <option value="Propuesta">Propuesta</option>
                          <option value="Negociación">Negociación</option>
                          <option value="Cierre">Cierre</option>
                        </select>
                      </div>
                      <div>
                        <label htmlFor="input-deal-value" className="block text-slate-500 font-medium mb-0.5 text-[9px] sm:text-[10px]">
                          Valor Estimado
                        </label>
                        <input
                          ref={inputDealValueRef}
                          id="input-deal-value"
                          type="text"
                          data-oa-id="input-deal-value"
                          value={dealValue}
                          onChange={(e) => setDealValue(e.target.value)}
                          placeholder="$35,000 USD"
                          className="w-full bg-slate-50 border border-slate-200 rounded px-1.5 py-1 min-h-[30px] text-[10px] sm:text-[11px] font-mono font-semibold text-slate-800 focus:outline-none focus:border-teal-500"
                        />
                      </div>
                    </div>
                  </form>
                )}
              </>
            ) : (
              <VortexCrmBillingPanel cfdiValidated={cfdiValidated} />
            )}
          </div>

          <VortexCrmVoiceBar
            isSpeaking={isSpeaking}
            isExecuting={isExecuting}
            speechText={speechText}
            barsEnergy={barsEnergy}
          />
        </div>
      </div>
    );
  }
);
