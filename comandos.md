# 🚀 Comandos de Encendido — Onboarding Assistant AI

Guía para levantar **todo el sistema en local** (Windows / PowerShell).
Cada servicio va en **su propia terminal** (se quedan escuchando y no devuelven el prompt).

| # | Servicio | Puerto | Comando (desde la raíz del repo) |
|---|---|---|---|
| 1 | 🔧 **Backend** (API Control Plane) | `3000` | `npm run start:api` |
| 2 | 🎙️ **Gateway de Voz** (WebSocket) | `3002` | `npm run start:voice` |
| 3 | 🖥️ **Frontend** (Next.js) | `3001` | `npm run dev` |

> **Requisitos previos (una sola vez):**
> - Node.js **≥ 20.11** (local: v24.14.1) y `npm install` en la raíz del repo.
> - Archivo **`.env`** en la raíz (ya configurado localmente; no se commitea).

---

## 1️⃣ Backend — API Control Plane (`:3000`)

```powershell
# Terminal 1 — desde la raíz del repo
npm run start:api
```

✅ **Listo cuando veas:**
```
[API_CONTROL_PLANE] Plano de control escuchando en el puerto 3000. {"routeCount":47}
```

---

## 2️⃣ Gateway de Voz — WebSocket (`:3002`)

```powershell
# Terminal 2 — desde la raíz del repo
npm run start:voice
```

✅ **Listo cuando veas:**
```
[VOICE_REALTIME_GATEWAY] Servidor de voz escuchando en el puerto 3002 con el canal /ws/v1/realtime.
```

---

## 3️⃣ Frontend — Landing + Paneles (`:3001`)

```powershell
# Terminal 3 — desde la raíz del repo
npm run dev
```

*(equivalente: `npm --prefix apps/web run dev`)*

✅ **Listo cuando veas:**
```
   ▲ Next.js 15.5.28
   - Local:        http://localhost:3001
 ✓ Ready in ...
```

> La primera compilación puede tardar ~30 segundos.

---

## 4️⃣ Probar la demo en vivo

| Qué | URL |
|---|---|
| Landing comercial | http://localhost:3001 |
| **Demo con voz** (requiere micrófono) | http://localhost:3001#demo-en-vivo |

Prueba decirle: *«Muéstrame la demostración completa»* — el asistente ejecuta las acciones reales sobre el tablero.

---

## 5️⃣ Verificar que los 3 servicios están arriba

```powershell
foreach ($port in 3000, 3001, 3002) {
  $c = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
  if ($c) { "P$port ARRIBA (PID $($c.OwningProcess | Select-Object -First 1))" } else { "P$port ABAJO" }
}
```

---

## 6️⃣ Apagar todo (liberar puertos)

```powershell
foreach ($port in 3000, 3001, 3002) {
  $c = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
  if ($c) { Stop-Process -Id ($c.OwningProcess | Select-Object -First 1) -Force; "P$port detenido" }
}
```

---

## 💡 Encendido rápido en un solo comando (3 ventanas nuevas)

```powershell
# Desde la raíz del repo: abre 3 ventanas de PowerShell, una por servicio
$repo = (Get-Location).Path
Start-Process powershell -WorkingDirectory $repo -ArgumentList '-NoExit','-Command','npm run start:api'
Start-Process powershell -WorkingDirectory $repo -ArgumentList '-NoExit','-Command','npm run start:voice'
Start-Process powershell -WorkingDirectory $repo -ArgumentList '-NoExit','-Command','npm run dev'
```

---

## 🧪 Comandos útiles de revisión

```powershell
npm run check:lines        # Auditoría del límite de 500 líneas por archivo
npm run typecheck          # TypeScript estricto (backend)
npm run typecheck:web      # TypeScript estricto (frontend)

npm run test:gemini-live   # Failover de voz con Gemini Live
npm run test:voice-tools   # Despacho de herramientas de voz (48 aserciones)
npm run test:public-demo-ops  # Guion operativo de la demo pública (19 aserciones)
npm run test:public-sdk    # Contrato público y SDK web

npm run verify:part12      # Batería: check:lines + typecheck + gemini-live
npm run verify:part13      # Batería: check:lines + typecheck + voz completa
npm run verify:part15      # Batería: check:lines + typecheck + public-sdk
```

---

## 🛠️ Problemas comunes

- **«El puerto ya está en uso»** → usa el bloque de la sección 6️⃣ y reintenta.
- **La demo no responde a la voz** → confirma que el servicio `:3002` está arriba y que `.env` tiene las claves de voz (`GEMINI_LIVE_*`, `VOICE_PROVIDER_*`).
- **El front muestra datos viejos** → el API `:3000` debe estar arriba; el proxy de desarrollo lo reenvía desde `:3001`.

---

# 🌐 Guía del Servidor VPS en Producción (Hetzner CX23)

### 📌 Datos de Acceso
- **IP:** `2.31.37.155`
- **Usuario:** `root`
- **Contraseña:** `NeuroChat2026!Onboarding` *(Actualizada en el primer ingreso obligatorio de Hetzner)*
- **Dominio Gratis Activo con SSL:** [https://2.31.37.155.sslip.io](https://2.31.37.155.sslip.io)

### 💻 Cómo conectarte desde tu PowerShell o CMD:
```powershell
ssh root@2.31.37.155
```

### 📊 Cómo ver los terminales y procesos en el VPS:
En el servidor no usamos terminales abiertas una por una porque si cierras la ventana se apagarían. En su lugar, usamos **PM2** (Process Manager 2):

```bash
# 1. Ver la lista de microservicios y su estado (online, RAM, CPU):
pm2 list

# 2. Ver la consola y logs en vivo de todos los microservicios:
pm2 logs

# 3. Ver logs de un servicio específico:
pm2 logs oa-web      # Frontend Next.js
pm2 logs oa-api      # Backend Fastify
pm2 logs oa-voice    # Gateway de Voz WebSocket

# 4. Monitor gráfico interactivo estilo consola:
pm2 monit

# 5. Reiniciar servicios tras actualizar código:
cd /var/www/onboarding-assistant
git pull origin main
npm run build:web
pm2 restart all
```

