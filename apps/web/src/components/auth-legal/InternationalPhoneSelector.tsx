/**
 * @archivo apps/web/src/components/auth-legal/InternationalPhoneSelector.tsx
 * @modulo apps/web (Selector Telefónico Internacional con Buscador de Países del Mundo)
 * @proposito
 *   Permite seleccionar cualquier país del mundo con búsqueda dinámica por nombre o prefijo,
 *   mostrando su bandera emoji y código telefónico en un dropdown ergonómico sobre pergamino.
 */

'use client';

import type { ReactElement } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CountryDialData } from './country-dial-codes';
import { WORLD_COUNTRIES } from './country-dial-codes';

export interface InternationalPhoneSelectorProps {
  readonly country: CountryDialData;
  readonly phoneNumber: string;
  readonly onCountryChange: (nextCountry: CountryDialData) => void;
  readonly onPhoneNumberChange: (nextNumber: string) => void;
  readonly disabled?: boolean;
}

export function InternationalPhoneSelector(props: InternationalPhoneSelectorProps): ReactElement {
  const { country, phoneNumber, onCountryChange, onPhoneNumberChange, disabled = false } = props;
  const [isOpen, setIsOpen] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const dropdownRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect((): (() => void) | undefined => {
    if (!isOpen) return undefined;
    function handleClickOutside(event: MouseEvent): void {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return (): void => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  useEffect((): void => {
    if (isOpen && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [isOpen]);

  const filteredCountries = useMemo((): readonly CountryDialData[] => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return WORLD_COUNTRIES;
    return WORLD_COUNTRIES.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.dial.includes(q) ||
        c.code.toLowerCase().includes(q)
    );
  }, [searchQuery]);

  function handleSelect(c: CountryDialData): void {
    onCountryChange(c);
    setIsOpen(false);
    setSearchQuery('');
  }

  return (
    <div ref={dropdownRef} style={{ position: 'relative', width: '100%' }}>
      <div style={{ display: 'flex', gap: 4 }}>
        {/* Botón selector de país */}
        <button
          type="button"
          onClick={(): void => { if (!disabled) setIsOpen(!isOpen); }}
          disabled={disabled}
          aria-expanded={isOpen}
          aria-label={`País seleccionado: ${country.name} (${country.dial})`}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 4,
            padding: '6px 8px',
            backgroundColor: 'var(--color-bone)',
            border: '1px solid var(--color-stone)',
            borderRadius: 'var(--radius-inputs, 4px)',
            cursor: disabled ? 'not-allowed' : 'pointer',
            fontSize: '12px',
            fontFamily: 'var(--font-cursorgothic)',
            color: 'var(--color-ink)',
            minWidth: '94px',
            flexShrink: 0,
          }}
        >
          <span style={{ fontSize: '14px', lineHeight: 1 }}>{country.flag}</span>
          <span className="atelier-mono" style={{ fontSize: '11.5px', color: 'var(--color-ink)' }}>{country.dial}</span>
          <span style={{ fontSize: '9px', color: 'var(--color-ash)', marginLeft: 'auto' }}>▾</span>
        </button>

        {/* Input del número telefónico */}
        <input
          id="reg-phone-number"
          className="atelier-input"
          type="tel"
          value={phoneNumber}
          onChange={(e): void => onPhoneNumberChange(e.target.value.replace(/[^0-9\s-]/g, ''))}
          placeholder="300 123 4567"
          disabled={disabled}
          style={{ flex: 1 }}
        />
      </div>

      {/* Menú desplegable con buscador dinámico de países */}
      {isOpen ? (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            left: 0,
            width: '280px',
            maxHeight: '260px',
            backgroundColor: 'var(--color-parchment)',
            border: '1px solid var(--color-stone)',
            borderRadius: 'var(--radius-cards, 4px)',
            boxShadow: 'var(--shadow-xl)',
            zIndex: 50,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          }}
        >
          {/* Buscador de país */}
          <div style={{ padding: '6px 8px', borderBottom: '1px solid var(--border-hairline)' }}>
            <input
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              onChange={(e): void => setSearchQuery(e.target.value)}
              placeholder="Buscar país o prefijo (+57)..."
              style={{
                width: '100%',
                padding: '4px 6px',
                fontSize: '11px',
                backgroundColor: 'var(--color-bone)',
                border: '1px solid var(--color-stone)',
                borderRadius: '3px',
                color: 'var(--color-ink)',
                outline: 'none',
              }}
            />
          </div>

          {/* Lista scrolleable de países del mundo */}
          <div style={{ overflowY: 'auto', flex: 1, padding: '2px 0' }}>
            {filteredCountries.length === 0 ? (
              <div style={{ padding: '8px', fontSize: '11px', color: 'var(--color-driftwood)', textAlign: 'center' }}>
                No se encontró ningún país
              </div>
            ) : (
              filteredCountries.map((c) => {
                const isSelected = c.code === country.code && c.dial === country.dial;
                return (
                  <button
                    key={`${c.code}-${c.dial}`}
                    type="button"
                    onClick={(): void => handleSelect(c)}
                    style={{
                      width: '100%',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      padding: '5px 8px',
                      fontSize: '11.5px',
                      backgroundColor: isSelected ? 'var(--color-linen)' : 'transparent',
                      border: 'none',
                      cursor: 'pointer',
                      textAlign: 'left',
                      color: 'var(--color-ink)',
                    }}
                    onMouseEnter={(e): void => {
                      if (!isSelected) e.currentTarget.style.backgroundColor = 'var(--color-bone)';
                    }}
                    onMouseLeave={(e): void => {
                      if (!isSelected) e.currentTarget.style.backgroundColor = 'transparent';
                    }}
                  >
                    <span style={{ fontSize: '13px' }}>{c.flag}</span>
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {c.name}
                    </span>
                    <span className="atelier-mono" style={{ fontSize: '10.5px', color: 'var(--color-ash)' }}>
                      {c.dial}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
