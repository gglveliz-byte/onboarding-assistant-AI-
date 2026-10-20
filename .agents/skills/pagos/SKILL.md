---
name: whop-integration
description: Guía genérica para integrar Whop en cualquier proyecto: checkout alojado o embebido, pagos únicos, precios variables, suscripciones, metadatos, webhooks firmados, verificación de pagos, idempotencia, reembolsos, pruebas y puesta en producción. Consultar obligatoriamente antes de implementar o modificar cobros con Whop.
---

# Skill: Integración de pagos con Whop

## 1. Propósito y alcance

Esta skill define un patrón reutilizable para integrar Whop en aplicaciones web, API, SaaS, marketplaces y otros sistemas. No presupone nombres de tablas, frameworks, rutas, marcas ni reglas de negocio específicas.

Cubre:

- Checkout alojado o embebido.
- Compras de precio fijo y pagos con importe variable cuando el flujo de checkout configurado lo permita.
- Suscripciones recurrentes y sincronización de su estado.
- Asociación segura entre una compra externa y el usuario, pedido o recurso interno.
- Webhooks firmados, idempotencia y procesamiento transaccional.
- Verificación de pagos, errores, cancelaciones, reembolsos y pruebas en sandbox.
- Configuración segura de credenciales y despliegue.

**Antes de tocar código de facturación, inspecciona el repositorio actual.** Identifica el framework, las rutas existentes, autenticación, acceso a la base de datos, modelos de pedido/pago, convenciones de errores, logging, pruebas y estrategia de configuración. Reutiliza la arquitectura existente y adapta los ejemplos de esta skill; no crees rutas o tablas duplicadas por defecto.

## 2. Principios no negociables

1. **El navegador nunca confirma un pago.** Un parámetro `?status=success`, una redirección, un callback del checkout o un mensaje del frontend solo sirven para UX. El backend debe confirmar el pago con un webhook verificado o consultando la API de Whop.
2. **No confiar en datos financieros enviados por el cliente.** El servidor determina producto, plan, precio, moneda, usuario y permisos. El cliente puede solicitar un identificador lógico de plan o producto permitido, nunca imponer el importe final.
3. **Firma antes de procesar.** Verifica la firma del webhook usando el helper oficial disponible en la versión instalada del SDK y el cuerpo original sin parsear. No inventes ni mantengas un algoritmo manual de HMAC si el SDK dispone de una función oficial para validarlo.
4. **Idempotencia real en la base de datos.** Impón una restricción única para el identificador del pago de Whop y, cuando proceda, otra para el identificador del evento. La comprobación y la concesión de saldo/acceso deben ser atómicas; un `SELECT` seguido de un `INSERT` separado no evita carreras.
5. **Pago y efecto interno en una transacción.** Registrar el pago y acreditar saldo, marcar un pedido como pagado o conceder acceso deben suceder en la misma transacción local cuando compartan base de datos. Para efectos externos, usa una cola o patrón outbox idempotente.
6. **Secretos exclusivamente en servidor.** La API key y el secreto del webhook no pueden llevar prefijos públicos como `NEXT_PUBLIC_`, incluirse en JavaScript del navegador ni imprimirse en logs.
7. **No guardar datos de tarjeta.** Utiliza checkout alojado o el componente de checkout oficial compatible. No construyas formularios propios para capturar PAN, CVV u otros datos de tarjeta.
8. **Montaje aislado del parser raw.** El parser de cuerpo sin procesar debe afectar solo al endpoint de webhook y ejecutarse antes de cualquier parser global que consuma o transforme el cuerpo.
9. **Fallos explícitos y recuperables.** Un evento válido que no necesite cambios se puede confirmar con `2xx`. Si ocurre un error transitorio antes de persistir de forma segura el evento, devuelve un `5xx` para permitir reintento. No confirmes el webhook antes de guardar el evento en una cola o mecanismo duradero.
10. **No asumir nombres de eventos o campos.** Verifica los eventos, estados, parámetros y tipos con la documentación vigente y la versión real de `@whop/sdk` instalada en el repositorio.

## 3. Fase de reconocimiento del proyecto

Antes de implementar:

1. Revisa `package.json`, lockfile, estructura de carpetas y versión actual de `@whop/sdk` / `@whop/checkout`, si existen.
2. Localiza la autenticación actual y determina cómo obtener la identidad del usuario **desde el servidor**.
3. Inspecciona el modelo actual de pedidos, pagos, saldo, créditos, membresías o permisos. No crees un sistema financiero paralelo si ya existe uno adecuado.
4. Identifica si el cobro es único, recurrente, por consumo o una combinación, así como su moneda, límites, impuestos y política de reembolso.
5. Determina si el proyecto requiere checkout alojado o embebido. Documenta cualquier requisito de marca blanca en la interfaz y comprueba los límites reales de personalización.
6. Identifica los mecanismos existentes para logs, colas, transacciones SQL, migraciones y pruebas.
7. Haz un plan de cambios mínimo, implementa la integración por etapas y ejecuta pruebas específicas antes de modificar otras partes.

No inventes rutas como `/api/payments/checkout` o tablas como `payments` si el proyecto ya tiene convenciones propias. Los nombres de los ejemplos siguientes son ilustrativos.

## 4. Configuración de Whop

### 4.1. Configuración del dashboard

En el entorno de desarrollo/sandbox y posteriormente en el entorno de producción:

1. Configura la empresa y los productos que se venderán.
2. Crea o identifica los planes de precio fijo necesarios. Un producto representa lo que se vende; un plan representa sus condiciones de precio y facturación.
3. Crea una Company API Key con los permisos mínimos que requiera el flujo real. No otorgues permisos administrativos innecesarios.
4. Configura un webhook público HTTPS y habilita solo los eventos que la aplicación necesita procesar, como pagos exitosos, pagos fallidos y reembolsos, además de los eventos de membresía/suscripción que el modelo use.
5. Guarda el secreto de firma que muestre el dashboard. Usa el valor íntegro y exacto; no lo recortes, no lo registres en logs ni lo codifiques en base64 por anticipado, salvo que la documentación de la versión concreta indique explícitamente otra cosa.
6. Mantén separados los identificadores, claves y secretos del sandbox y de producción. Los IDs de producto y plan de un entorno no deben suponerse válidos en el otro.

Los nombres y permisos exactos de los eventos/API pueden evolucionar. Confírmalos en el dashboard y la documentación oficial durante la integración.

### 4.2. Variables de entorno

Adapta los nombres a las convenciones del proyecto. Una configuración típica es:

```env
WHOP_COMPANY_API_KEY=apik_...
WHOP_WEBHOOK_SECRET=ws_...
WHOP_COMPANY_ID=biz_...
WHOP_SANDBOX=true
APP_URL=http://localhost:3000
```

- `WHOP_COMPANY_API_KEY`: credencial privada de servidor.
- `WHOP_WEBHOOK_SECRET`: secreto privado del webhook. El prefijo puede depender de la configuración/versión; copia exactamente el secreto mostrado por Whop.
- `WHOP_COMPANY_ID`: identificador de empresa, si el flujo elegido lo necesita.
- `WHOP_SANDBOX`: bandera interna para escoger entorno.
- `APP_URL`: origen canónico de la aplicación para construir URLs de retorno permitidas.

Valida las variables al iniciar la aplicación o en el punto central de configuración. Si falta una variable necesaria, falla con un error de configuración claro y sin revelar el valor del secreto. Nunca uses datos reales de producción como valores de ejemplo en documentación, tests o commits.

### 4.3. Cliente SDK

Usa el SDK oficial y la API que correspondan a la versión instalada. No mezcles ejemplos de versiones incompatibles ni actualices dependencias mayores sin revisar cambios de API.

Ejemplo de inicialización para las versiones del SDK que exponen `WhopClient` y `WhopEnvironment`:

```ts
import { WhopClient, WhopEnvironment } from "@whop/sdk";

const apiKey = process.env.WHOP_COMPANY_API_KEY;
if (!apiKey) throw new Error("Falta WHOP_COMPANY_API_KEY");

export const whop = new WhopClient({
  token: apiKey,
  environment:
    process.env.WHOP_SANDBOX === "true"
      ? WhopEnvironment.Sandbox
      : WhopEnvironment.Production,
});
```

La forma de inicializar el cliente puede variar según la versión. Si el repositorio ya tiene un cliente Whop correctamente configurado, reutilízalo y verifica que apunta al entorno deseado. Nunca permitas que una clave de sandbox se envíe accidentalmente al host de producción.

## 5. Diseñar el flujo de checkout

### 5.1. Flujo recomendado

1. El usuario inicia la compra desde una sesión autenticada o una operación autorizada.
2. El backend valida CSRF cuando use cookies, verifica permisos y resuelve el producto/plan desde configuración fiable.
3. El backend calcula el precio esperado con reglas del servidor y crea un registro interno de pedido/operación en estado `pending`.
4. El backend crea la checkout configuration usando el plan permitido y adjunta una referencia interna en `metadata`, por ejemplo `{ order_id: "..." }`.
5. El backend envía al frontend solo los datos necesarios para abrir el checkout, por ejemplo el identificador de la sesión o la URL de compra.
6. El usuario completa el pago en el checkout alojado o embebido.
7. El webhook firmado confirma el resultado y permite actualizar el estado interno de forma idempotente.
8. La pantalla de retorno consulta el estado interno de la aplicación; no acredita saldo ni activa permisos por su cuenta.

### 5.2. Crear una checkout configuration

El patrón de API moderno puede utilizar `checkoutConfigurations.create`. Los parámetros exactos dependen de la versión y modalidad; verifica el tipo de checkout vigente en la documentación de Whop antes de copiarlo.

Ejemplo ilustrativo para un plan de precio fijo:

```ts
// Ejecutar en el backend después de autenticar al usuario y crear el pedido.
const order = await orders.createPending({
  userId: authenticatedUser.id,
  productKey: validatedProductKey,
});

const checkout = await whop.checkoutConfigurations.create(
  {
    plan_id: serverSidePlanId,
    mode: "payment",
    metadata: { order_id: order.id },
  },
  {
    headers: { "Idempotency-Key": `checkout-${order.id}` },
  },
);

return {
  orderId: order.id,
  sessionId: checkout.id,
};
```

Este ejemplo requiere adaptar `orders`, la autenticación, `serverSidePlanId` y la forma concreta en que el SDK espera recibir la idempotency key. Comprueba que el SDK realmente envía la cabecera `Idempotency-Key`; no asumas que una opción de conveniencia funciona en todas las versiones.

**No aceptes un `plan_id`, `userId`, importe o URL de retorno arbitrarios sin validación del servidor.** El usuario debe comprar solo productos que tenga permitidos y con el precio definido en la configuración interna.

### 5.3. Precio fijo, importe variable y recargas

**Precio fijo:** mantiene una lista de planes aprobados en configuración o base de datos. Resuelve el identificador de Whop desde una clave lógica interna como `basic_monthly`, no desde una ID libre proporcionada por el navegador.

**Importe variable:** solo usa un flujo de checkout soportado oficialmente para crear una configuración de precio variable. Valida tipo numérico, precisión, mínimo, máximo, moneda y propósito en el servidor. Para dinero, evita cálculos con `float` como fuente de verdad; utiliza enteros en unidades menores cuando la moneda y el modelo lo permitan o una librería decimal fiable.

Si el checkout permite definir un plan inline, el SDK puede exponer una estructura conceptual como `plan: { initial_price, plan_type, currency }`; confirma los nombres y validaciones exactos de la versión instalada. No envíes un `plan_id` y un plan inline a la vez si el contrato de la API los define como alternativas.

En recargas o prepago:

- Valida el monto mínimo y máximo en backend.
- Registra la recarga pendiente antes de crear el checkout.
- Adjunta el ID interno de la recarga en `metadata`.
- Acredita el saldo únicamente después de confirmar el pago.
- Mantén un registro de cada recarga y cada movimiento de saldo. No dependas solo de un saldo modificable sin auditoría.
- Define qué sucede en reembolso, disputa, pago revertido o duplicado; la reversión también debe ser idempotente.

### 5.4. Suscripciones

Para suscripciones, usa un plan configurado con periodicidad y condiciones aprobadas, y confirma los estados con los eventos vigentes de membresía/suscripción de Whop y/o una consulta autenticada a la API.

El modelo interno debería registrar, según lo que aplique: usuario, ID de plan, ID de membresía/suscripción externa, estado, inicio, renovación o vencimiento, cancelación, periodo de gracia y último pago confirmado.

No confundas el estado de una membresía con el resultado de una transacción individual. Una renovación fallida, una cancelación al final del periodo, un reembolso y una membresía ya vencida pueden requerir reglas distintas. Define y prueba esas transiciones explícitamente.

## 6. Frontend: checkout y retorno

### 6.1. Inicio del checkout

El frontend llama al endpoint interno de inicio de compra y usa los datos que devuelve el backend. No debe importar el SDK privado ni conocer la API key.

Para checkout alojado, redirige solo a la URL creada/devuelta por el flujo del servidor y validada como procedente de Whop. No construyas la URL concatenando datos controlables por el usuario.

Para checkout embebido, utiliza el paquete/componente oficial que corresponda a la versión actual e introduce únicamente el `sessionId` o identificador autorizado que genere el backend. Configura la Content Security Policy únicamente con los orígenes documentados que el embed necesite.

### 6.2. Mensajes y marca blanca

En la interfaz propia, describe el método de pago con texto adecuado al producto, por ejemplo “Pagar”, “Tarjeta de crédito o débito” o “Completar pago”, siempre que describa realmente los métodos disponibles. No prometas un método que el checkout no admita.

Si el proyecto tiene un requisito de marca blanca, no menciones al proveedor en textos, botones o errores de la interfaz de la aplicación. **No supongas que un checkout alojado deja de mostrar la marca del proveedor:** si el requisito abarca toda la experiencia de pago, evalúa el checkout embebido y verifica sus posibilidades actuales de personalización y sus condiciones. No ocultes información legal obligatoria ni hagas afirmaciones engañosas.

### 6.3. Página de retorno

La página de éxito/cancelación sirve para informar al usuario y consultar el estado real del pedido mediante un endpoint autenticado de la aplicación.

```ts
// Pseudocódigo de UI; no concede acceso ni acredita dinero.
const result = await fetch(`/api/orders/${orderId}/status`, {
  cache: "no-store",
});

// Mostrar el estado comunicado por TU backend.
// Si sigue pending, permite reintentar la consulta o explica que se está confirmando.
```

No actives funcionalidades basándote solo en `status=success`, el `onComplete` de un widget o un ID de pago enviado por el navegador. Estos elementos pueden iniciar una consulta server-side, pero no sustituyen la verificación.

## 7. Webhooks firmados

### 7.1. Regla sobre el cuerpo raw

La verificación depende del cuerpo original y de las cabeceras de firma. No hagas `JSON.parse` antes de verificarlo; reserializar JSON puede alterar espacios, escapes u otros bytes.

La vía preferida es utilizar `unwrapWebhook` del SDK oficial compatible con la versión instalada, pasando el texto raw y las cabeceras originales. Whop ha documentado el patrón `unwrapWebhook(raw, { headers, key: WHOP_WEBHOOK_SECRET })` en versiones actuales; si tu versión expone `whop.webhooks.unwrap`, sigue el contrato de esa versión. Usa el secreto exactamente como lo entrega el dashboard y no lo pre-codifiques sin indicación explícita.

### 7.2. Ejemplo en Next.js App Router

```ts
import { unwrapWebhook } from "@whop/sdk/helpers";

export async function POST(request: Request) {
  const secret = process.env.WHOP_WEBHOOK_SECRET;
  if (!secret) {
    return new Response("Webhook secret not configured", { status: 503 });
  }

  // Leer el cuerpo antes de cualquier parseo JSON.
  const raw = await request.text();
  const headers = Object.fromEntries(request.headers.entries());

  let event: { id?: string; type: string; data?: Record<string, unknown> };
  try {
    event = unwrapWebhook(raw, { headers, key: secret }) as typeof event;
  } catch {
    return new Response("Invalid webhook signature", { status: 401 });
  }

  try {
    await processVerifiedWhopEvent(event, headers);
    return Response.json({ received: true }, { status: 200 });
  } catch (error) {
    // Registra contexto seguro, nunca el secreto. Devuelve 5xx si no se ha
    // persistido el evento de forma duradera y puede ser reintentado.
    console.error("Whop webhook processing failed", safeErrorInfo(error));
    return new Response("Temporary processing failure", { status: 500 });
  }
}
```

`processVerifiedWhopEvent` y `safeErrorInfo` son funciones del proyecto, no funciones integradas del SDK. Adáptalas a su manejo de errores, logs y base de datos. No registres el cuerpo completo si contiene datos personales o comerciales sensibles.

### 7.3. Ejemplo en Express

El endpoint debe recibir `Buffer` sin procesar. Registra la ruta del webhook antes de cualquier `express.json()` global que pueda consumir el cuerpo, o excluye expresamente esa ruta del parser global.

```js
const express = require("express");
const { unwrapWebhook } = require("@whop/sdk/helpers");

const app = express();

app.post(
  "/webhooks/whop",
  express.raw({ type: "*/*", limit: "1mb" }),
  async (req, res) => {
    const secret = process.env.WHOP_WEBHOOK_SECRET;
    if (!secret) return res.status(503).send("Webhook secret not configured");

    if (!Buffer.isBuffer(req.body)) {
      return res.status(400).send("Raw body required");
    }

    let event;
    try {
      const raw = req.body.toString("utf8");
      event = unwrapWebhook(raw, {
        headers: req.headers,
        key: secret,
      });
    } catch {
      return res.status(401).send("Invalid webhook signature");
    }

    try {
      await processVerifiedWhopEvent(event, req.headers);
      return res.status(200).json({ received: true });
    } catch (error) {
      console.error("Whop webhook processing failed", safeErrorInfo(error));
      return res.status(500).send("Temporary processing failure");
    }
  },
);

// El parser JSON global va después de registrar el endpoint raw.
app.use(express.json());
```

Verifica compatibilidad CommonJS/ESM de `@whop/sdk/helpers` con la configuración real del proyecto. Si el SDK instalado no exporta esa ruta de esta forma, usa la importación documentada para esa versión; no reemplaces el helper por una verificación manual adivinada.

### 7.4. Qué hacer con cada evento

Primero verifica la firma. Luego valida la forma del evento y el tipo antes de realizar cambios.

- **Pago exitoso:** valida el ID de pago, el pedido asociado y las condiciones esperadas; consulta a Whop si necesitas confirmar campos o el estado final. Continúa con el procesamiento idempotente.
- **Pago fallido:** registra el resultado, conserva el pedido como no pagado y muestra un estado apropiado. No concedas saldo/acceso.
- **Reembolso o reversión:** actualiza la transacción y aplica la política de reversión del negocio mediante una operación idempotente. No asumas que el reembolso retira automáticamente el acceso dentro de tu aplicación.
- **Membresía o suscripción:** sincroniza el estado a partir de los eventos que hayas habilitado y de los estados oficiales. Maneja cancelación, reactivación, expiración y fallos de renovación.
- **Evento desconocido o no aplicable:** después de verificarlo, registra un diagnóstico seguro y responde `2xx` si no se necesita reintento.
- **Evento con forma inválida o firma incorrecta:** no lo proceses; responde con un código no exitoso adecuado, habitualmente `400` o `401`.

Usa los nombres exactos de eventos que el dashboard y la versión actual de Whop exponen. No dependas exclusivamente de una prueba del dashboard para validar el evento de producción real.

## 8. Idempotencia y consistencia financiera

### 8.1. Persistencia recomendada

Adapta estos conceptos a los modelos existentes. No es obligatorio crear todas las tablas si el sistema ya almacena esta información de forma equivalente.

**Pago/transacción**

- ID interno.
- Proveedor: `whop`.
- ID de pago externo de Whop.
- ID del pedido/operación interna.
- Importe esperado y pagado; moneda.
- Estado y marcas de tiempo.
- Referencia a usuario/cliente, solo si es necesaria.
- Datos mínimos de auditoría sin secretos.

Impón una restricción única sobre la combinación del proveedor y el ID del pago externo, por ejemplo `UNIQUE(provider, provider_payment_id)`.

**Evento de webhook procesado** (opcional, recomendado)

- ID del evento de Whop cuando esté disponible.
- Tipo de evento.
- Estado de procesamiento y marcas de tiempo.
- Número de intentos o error categorizado si resulta útil.

Impón una restricción única sobre el ID del evento cuando sea estable. Aun con esta tabla, conserva la restricción única de pago: diferentes eventos o reintentos pueden referirse a la misma transacción.

### 8.2. Algoritmo transaccional

Dentro de una transacción de base de datos:

1. Comprueba que el pedido interno existe, pertenece al usuario esperado y sigue siendo elegible.
2. Comprueba que el pago externo corresponde al producto/plan esperado, su moneda e importe cumplen las reglas y el estado oficial es exitoso.
3. Inserta el registro del pago con el ID externo único. Si existe, no vuelvas a acreditar saldo ni conceder acceso.
4. Actualiza el pedido y registra el movimiento de saldo/permiso relacionado.
5. Guarda el evento o el resultado de procesamiento cuando corresponda.
6. Confirma la transacción. Si cualquiera de los pasos locales falla, revierte todo para que la entrega no quede a medias.

Ejemplo conceptual de SQL para deduplicación:

```sql
INSERT INTO payment_transactions (
  provider,
  provider_payment_id,
  order_id,
  amount_minor,
  currency,
  status
)
VALUES ($1, $2, $3, $4, $5, 'succeeded')
ON CONFLICT (provider, provider_payment_id) DO NOTHING
RETURNING id;
```

La lógica de negocio solo aplica el efecto financiero si el `INSERT ... RETURNING` devuelve una fila, y el insert, la modificación de saldo/acceso y la actualización del pedido ocurren en la **misma transacción**. Ajusta la sintaxis al motor y al ORM del proyecto.

Si el efecto es externo a la base de datos —por ejemplo, emitir una licencia en otro servicio—, registra primero una tarea outbox dentro de la misma transacción y procésala con una clave idempotente. No confíes en una llamada remota no transaccional hecha en medio de una transacción SQL.

### 8.3. Verificación semántica del pago

No basta con comprobar que `event.type === "payment.succeeded"`. Antes de aplicar el beneficio, verifica la correspondencia entre pago y compra:

- El ID de pago externo es válido y no se ha procesado antes.
- La referencia interna existe y fue creada por el servidor.
- El producto/plan corresponde a la compra esperada.
- El importe y la moneda concuerdan con el pedido, con reglas explícitas para impuestos, descuentos y ajustes permitidos.
- El estado de pago expuesto por el SDK/APi es el correcto para esa versión.
- La referencia de usuario o pedido no procede de un dato libre enviado por el navegador.

La documentación de Whop distingue el estado general del pago de `substatus`; en los ejemplos actuales de la API, `substatus === "succeeded"` es la comprobación indicada para confirmar ese resultado. Revalida ese campo contra la respuesta vigente de la API antes de codificarlo y no compares a ciegas con `status`.

## 9. Verificación posterior desde el backend

Si el frontend recibe un identificador de recibo/pago mediante el componente de checkout, puede enviarlo a un endpoint interno para iniciar la confirmación. El endpoint debe:

1. Validar autenticación, autorización y formato del identificador.
2. Recuperar el pago con el SDK/API privada en el servidor.
3. Verificar el resultado final, el plan/producto y el importe esperado.
4. Resolver el pedido mediante una referencia generada por el servidor, por ejemplo `metadata.order_id`.
5. Devolver únicamente el estado necesario para la UI.

Si el pago todavía no puede leerse o sigue pendiente, devuelve un estado intermedio controlado para permitir una consulta posterior. No reveles detalles de pagos de otros usuarios. La confirmación desde el navegador mejora la experiencia, pero el webhook debe mantener la consistencia si el usuario cierra la página.

## 10. Errores, reintentos y resiliencia

- Usa `try/catch` en los límites de integración y traduce los errores externos a respuestas comprensibles para el usuario.
- No devuelvas stack traces, credenciales, firmas ni cuerpos sensibles al cliente.
- Aplica timeouts razonables y límites de tamaño para el webhook.
- Para cargas de trabajo lentas, guarda el evento de forma duradera y encola el procesamiento; solo devuelve `2xx` cuando sepas que el evento no se ha perdido.
- Si falla temporalmente la base de datos o la cola antes de persistir el evento, responde `5xx` para permitir que el emisor reintente.
- El procesamiento repetido debe producir el mismo estado final, sin duplicar cobros internos ni beneficios.
- Añade métricas/logs por resultado: firma inválida, evento ignorado, duplicado, pendiente, procesado y error. No registres secretos ni más datos personales de los necesarios.
- Ten un procedimiento de reconciliación para comparar pedidos pendientes con los pagos de Whop y reparar discrepancias con acciones auditables.

## 11. Pruebas sin dinero real

Realiza las pruebas en la cuenta de **sandbox** y con claves/IDs exclusivos de sandbox. La disponibilidad de tarjetas de prueba y resultados depende de la configuración vigente; consulta la guía oficial actual para seleccionar los datos de prueba correctos.

### Matriz mínima de pruebas

1. **Pago exitoso:** el checkout se abre, el pago se registra como exitoso y el pedido queda pagado una sola vez.
2. **Pago fallido/declinado:** no se acredita saldo ni se concede acceso.
3. **Cierre de navegador:** el webhook completa el flujo aunque el usuario no vuelva a la página.
4. **Webhook con firma inválida:** recibe rechazo y no cambia ningún estado financiero.
5. **Cuerpo alterado:** una modificación mínima del cuerpo invalida la firma.
6. **Reenvío duplicado:** procesar varias veces el mismo evento no repite la operación.
7. **Dos eventos para el mismo pago:** la restricción única de pago evita una segunda acreditación.
8. **Pedido inexistente o referencia inválida:** no se concede beneficio y el caso queda registrado de forma segura.
9. **Importe, moneda o plan incorrectos:** el pago no activa una compra distinta.
10. **Reembolso:** el sistema refleja el reembolso y aplica la política de revocación/reversión solo una vez.
11. **Suscripción:** prueba activación, renovación, fallo de cobro, cancelación y expiración, según el negocio.
12. **Error transitorio de base de datos/cola:** el evento se reintenta sin perderse ni duplicarse.
13. **Sandbox y producción aislados:** nunca se mezclan claves, secretos, endpoints o IDs entre entornos.
14. **Retorno falsificado:** abrir manualmente una URL con `status=success` no concede nada.

Crea tests unitarios para la lógica de procesamiento y pruebas de integración para el endpoint raw. Usa pruebas deterministas de firma y fixtures sanitizados; no introduzcas secretos reales en el repositorio.

## 12. Checklist de puesta en producción

- [ ] SDK y versiones confirmados; no hay APIs copiadas de otra versión incompatible.
- [ ] Credenciales de producción guardadas en el gestor de secretos del entorno.
- [ ] API key con permisos mínimos necesarios.
- [ ] Webhook configurado con HTTPS y los eventos requeridos.
- [ ] Endpoint lee el cuerpo original y valida la firma con el helper oficial.
- [ ] Ruta raw registrada antes del parser JSON global, cuando aplique.
- [ ] Índice/restricción única en la base de datos para los pagos externos.
- [ ] Actualización del pago y concesión de beneficio atómicas o protegidas con outbox.
- [ ] Precio, moneda, plan y pedido se validan en servidor.
- [ ] El retorno del navegador nunca se usa como confirmación financiera.
- [ ] Reembolsos, cancelaciones y fallos de renovación tienen reglas definidas.
- [ ] Logs y métricas no exponen secretos ni datos sensibles.
- [ ] Pruebas de duplicados, firma inválida, pago fallido y navegación interrumpida completadas.
- [ ] Variables, IDs, planes y webhook de sandbox reemplazados explícitamente por los de producción.
- [ ] Procedimiento de reconciliación y atención de pagos atascados documentado.

## 13. Errores frecuentes que se deben evitar

- Usar `status=success` como prueba de pago.
- Parsear el JSON del webhook antes de verificar la firma.
- Calcular HMAC manualmente con un formato supuesto, ignorando el helper oficial del SDK.
- Precodificar el secreto en base64 o quitar su prefijo sin que lo indique la documentación aplicable.
- Montar `express.json()` global antes del endpoint raw y perder el cuerpo original.
- Confiar en `userId`, importe, moneda o `redirect_url` enviados desde el navegador.
- Hacer primero una consulta de duplicados y, por separado, actualizar saldo sin restricción única ni transacción.
- Acreditar saldo cada vez que llega un evento `payment.succeeded` sin comprobar el ID del pago.
- Tratar el estado del pago, la membresía y el acceso como un único estado.
- Responder `200` antes de guardar el evento de forma duradera.
- Crear productos/planes repetidos o nuevos cada vez que se carga la página, sin una estrategia clara de aprovisionamiento.
- Probar con recursos de producción o asumir que IDs de sandbox funcionan en vivo.
- Afirmar que un checkout alojado es completamente de marca blanca sin verificar su experiencia real.

## 14. Referencias oficiales para validar antes de implementar

La documentación puede cambiar. Consulta la página vigente correspondiente a la versión del SDK usada en el repositorio:

- Guía de checkout API: https://whop.com/blog/integrate-checkout-api/
- Sandbox de Whop: https://whop.com/blog/whop-sandbox/
- SDK y API de desarrollador: https://docs.whop.com/
- Crear un plan: https://docs.whop.com/api-reference/plans/create-plan

Al modificar cobros existentes, revisa también los logs y las pruebas actuales de la aplicación y ejecuta la matriz relevante de pruebas antes de considerar terminado el cambio.
