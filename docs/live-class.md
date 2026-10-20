# Aula en vivo (Live class)

**Estado: DEMO.** Hoy el aula en vivo funciona completa en el navegador, con participantes
simulados y datos de ejemplo. No hay servidor de video, no se graba nada y no cuesta nada.
Todo está listo para conectarse a LiveKit cuando se decida: alcanza con cargar 3 variables
en Vercel (más el grabador y la transcripción, para tener insights reales).

## Qué hay en el código

| Archivo | Qué hace |
|---|---|
| `public/live-class.js` | Toda la pantalla: inicio (sesiones), sala de espera con cámara real y el consentimiento (una casilla, se pide una sola vez; "Justificá tu respuesta" si no acepta), sala con video, plan con temporizadores, chat, indicador de grabación automática con pausa del docente, procesamiento e insights; y en el menú del perfil "Grabación de mis clases". Textos en español en un bloque `Object.assign(I18N_ES, …)`. |
| `public/live-class.css` | Estilos (sin librerías). Funciona desde 768 px de ancho. |
| `api/class/config.js` | `GET` → `{configured: true/false}`. Nunca devuelve claves. |
| `api/class/token.js` | `POST` → token de LiveKit (JWT HS256 firmado con `node:crypto`). Verifica la sesión de Supabase. Lee el consentimiento de la base (`my_consent()` con la sesión del usuario; **nunca** lo que manda el navegador) y pone `recorded` / `consent` / `minor` / `guardian_consent` en la metadata. Devuelve **501** mientras falten las variables. |
| `api/notify/consent.js` | `POST` → avisa por email a los admins cuando alguien no acepta la grabación (solo con `RESEND_API_KEY` + `SUPABASE_SERVICE_ROLE_KEY`; si no, no hace nada). |
| `api/livekit/webhook.js` | Recibe los eventos de LiveKit y verifica la firma. Por ahora solo registra (TODOs para el grabador y Supabase). |
| `api/_lib/livekit.js` | Firma/verificación de JWT y consulta de usuario en Supabase (compartido). |
| `supabase/migrations/001_base.sql` | Consentimiento único por persona (`user_consents`, `consent_declines`, `my_consent`, …): ver README → *Recording consent*. |
| `supabase/migrations/002_live_class.sql` | Tablas y permisos (RLS) de las llamadas. **No ejecutar todavía.** Su tabla `consents` es ahora un registro de auditoría por llamada que escribe solo el servidor a partir de `user_consents`. |
| `tests/e2e-live.cjs`, `tests/e2e-consent.cjs`, `tests/api-live.test.mjs`, `tests/api-consent.test.mjs`, `tests/sql/002_live_class_rls.sql`, `tests/sql/consent.sql` | Pruebas. |

### Cómo se elige Demo o LiveKit

`public/live-class.js` define una interfaz `LiveProvider` y dos implementaciones:

- **`DemoProvider`** (la que se usa hoy): participantes simulados, quién habla, mano levantada,
  chat local y grabación simulada. Nada sale del navegador.
- **`LiveKitProvider`**: se conecta con `livekit-client` (`Room`, `connect(url, token)`,
  publica cámara y micrófono, escucha participantes remotos, quién habla y mensajes de datos
  para chat / mano / pausa de la grabación).

Al entrar a la sala, la app llama a `GET /api/class/config`:

- `{configured:false}` (o cualquier error) → **Demo**. El SDK de LiveKit ni se descarga.
- `{configured:true}` → descarga `livekit-client@2.22.3` desde jsDelivr, pide el token a
  `POST /api/class/token` con la sesión del usuario y se conecta. Si la conexión falla, avisa y
  abre la demo.

Las pruebas cubren los dos caminos (`tests/e2e-live.cjs`, último escenario).

## Cómo activarlo

### 1. LiveKit Cloud (video)

1. Crear una cuenta en <https://cloud.livekit.io> y un proyecto (por ejemplo `teroclass-prod`).
2. Región: LiveKit Cloud conecta a cada persona con el servidor más cercano (São Paulo para
   Uruguay). Si el plan contratado permite fijar la región (*region pinning*), fijarla en
   Sudamérica / Brasil para que los datos queden en la región.
3. En *Settings → Keys* crear una API key. Anotar la URL (`wss://<proyecto>.livekit.cloud`),
   la key y el secret.
4. En *Settings → Webhooks* agregar `https://<tu-app>.vercel.app/api/livekit/webhook`
   con esa misma API key.

### 2. Variables en Vercel

Vercel → Project → Settings → Environment Variables (Production), luego **Redeploy**:

| Variable | Ejemplo |
|---|---|
| `LIVEKIT_URL` | `wss://teroclass-prod-xxxx.livekit.cloud` |
| `LIVEKIT_API_KEY` | `APIxxxxxxxx` |
| `LIVEKIT_API_SECRET` | (secreto) |

Comprobar: `https://<tu-app>/api/class/config` debe responder `{"configured":true}`.
Desde ese momento las videollamadas son reales (sin grabación todavía: el indicador "Grabando" y la
pausa del docente se muestran, pero hasta que exista el grabador no se guarda ningún audio).

> Si el webhook responde "checksum does not match" en el primer deploy, agregar también
> `NODEJS_HELPERS=0` (hace que Vercel entregue el cuerpo crudo para verificar la firma).

### 3. Base de datos

Supabase → SQL Editor → pegar y ejecutar `supabase/migrations/002_live_class.sql`
(después del `001_base.sql` actual, que trae el consentimiento único; se puede volver a ejecutar sin riesgo).

### 4. Grabador (Azure Container Apps) — esquema

Un servicio pequeño, en la misma región que el almacenamiento (Brazil South):

1. El webhook (`track_published`) le avisa qué sala y qué pista grabar.
2. Entra a la sala como participante oculto (token con `hidden: true`, `canSubscribe: true`,
   `canPublish: false`) usando el SDK de servidor de LiveKit.
3. **Graba automáticamente desde que la sala está en vivo** (no hay botón REC): se suscribe **solo**
   a las pistas de audio de quienes tienen `recorded: true` en su metadata (lo pone `api/class/token.js`
   leyendo `my_consent()` de la base; un "no" o un consentimiento revocado o de otra versión → `false`).
   Nunca graba video.
4. Respeta la **pausa** del docente: mensajes de datos `{type:"rec", state:"paused"}` y `{type:"rec", state:"on"}`
   (solo cuenta los del participante con `role: "teacher"` en la metadata). El navegador del docente reanuda solo
   a los 5 minutos y le reenvía el estado a quien entra durante una pausa; `state:"off"` = terminó la clase.
   Guarda solo los tramos con voz (detección de actividad de voz), un archivo por micrófono, en Azure Blob Storage.
5. Inserta una fila en `recordings` con `retention_until = now() + 30 días` y, por participante, las filas de
   auditoría en `consents` (002) copiadas del `user_consents` vigente (`user_consent_id`).

Alternativa sin código propio: *Track Egress* de LiveKit (audio por pista directo a Azure Blob),
con menos control sobre pausas y recorte de silencios.

### 5. Transcripción e insights

1. Al terminar la sala (`room_finished`): *batch transcription* de **Azure AI Speech** (Brazil South)
   por cada archivo. Como cada archivo es un solo micrófono, no hace falta separar voces ni
   identificar por huella de voz.
2. Guardar los segmentos en `transcript_segments`.
3. Llamar al GPT-4o que ya usa TeroClass con la planificación de la clase + la transcripción, pidiendo
   JSON con la misma forma que los datos de ejemplo de `public/insights-view.js` (`SAMPLES.*.students[]`
   y `SAMPLES.*.teacher`, o el payload de `buildDemoPayload`). Guardar (service role) en `student_insights` /
   `teacher_insights` de **001_base.sql**, para la clase del calendario de la llamada
   (`live_sessions.class_session_id`), con `is_demo = false` y `participant_id` del participante.
4. Las pantallas de Insights (`public/insights-panel.js`) ya leen esas tablas (hoy con datos de demo:
   ver README → *Class insights*). No hace falta cambiar la interfaz.

### 6. Borrado automático

Tarea diaria (Container Apps Job o Supabase cron con la service role key):
`select * from recordings_due_for_deletion()` → borrar cada blob → `update recordings set deleted_at = now(), status = 'deleted'`.

## Costos (estimación, verificar precios vigentes)

Ejemplo: clase de 45 min con 25 estudiantes + docente.

| Pieza | Cómo se cobra | Estimado por clase |
|---|---|---|
| LiveKit Cloud | minutos de conexión por participante (26 × 45 ≈ 1.170 min) y ancho de banda. Tiene plan gratuito para probar y planes mensuales con minutos incluidos. | según plan; centavos de dólar por clase con minutos incluidos |
| Grabador (Azure Container Apps) | consumo por segundo, escala a cero cuando no hay clases | muy bajo (centavos) |
| Azure Blob Storage | GB/mes; solo voz y se borra a los 30 días | despreciable |
| Azure AI Speech (batch) | por hora de audio; solo voz ≈ 3 h por clase | ≈ US$ 0,5–1 |
| GPT-4o (Azure OpenAI) | tokens; ≈ 20–40 mil por clase | ≈ US$ 0,1–0,4 |

Hoy, en modo Demo: **US$ 0**.

## Privacidad — checklist antes de activar

- [ ] Texto de consentimiento revisado por un abogado (Uruguay: Ley 18.331; España: RGPD/LOPDGDD) y versión cargada en `CONSENT_VERSION` (`api/class/token.js`, `live-class.js`) y `tc_consent_version()` (`001_base.sql`).
- [ ] Decisión del producto (2026-10): **un solo consentimiento** (grabación + análisis con IA + almacenamiento), se pide una vez y un "sí" queda guardado; un "no" pide justificación obligatoria (va a la institución) y se vuelve a preguntar en la próxima clase. Sin consentimiento se participa igual, sin grabar. Confirmar con el abogado que agrupar los tres fines en una casilla es válido.
- [ ] Menores de 18: consentimiento de madre/padre/tutor (nombre, email y confirmación) — la base lo exige (`user_consents_minor_guardian`; en 002, `consents_guard`).
- [ ] Indicador "● Grabando — solo quienes dieron su consentimiento" siempre visible para todos; el docente puede pausar (se reanuda sola a los 5 min).
- [ ] Se identifica a cada persona por su micrófono, nunca por huella de voz. Sin detección de emociones.
- [ ] Solo se graba audio con voz de quienes consintieron; nunca video.
- [ ] Audio original borrado a los 30 días (tarea diaria activa y probada).
- [ ] Datos en la región (LiveKit con región fijada si el plan lo permite; Azure en Brazil South).
- [ ] Revocar desde el perfil (`revoke_recording_consent`, o `revoke_consent` en 002) detiene la grabación de esa persona (hoy: desde la próxima clase; el grabador tiene que reaccionar también dentro de la sala).
- [ ] Insights del docente privados (solo docente y admins de su institución); cada estudiante ve solo los suyos y el mensaje del docente cuando lo publica (ya aplicado en 001_base.sql).
- [ ] Acceso del tutor/a a los insights publicados del menor (hoy no existe: definirlo antes de grabar).
- [ ] Contrato de encargado de tratamiento con LiveKit y Microsoft.

## Pruebas

```bash
NODE_PATH=/opt/npm-tools/node_modules node tests/e2e-live.cjs        # navegador, modo demo (+ camino LiveKit)
NODE_PATH=/opt/npm-tools/node_modules node tests/e2e-consent.cjs     # consentimiento, justificación, perfil, admin
node --no-warnings --test tests/api-live.test.mjs tests/api-consent.test.mjs   # token (consentimiento desde la base) / config / webhook / aviso
psql -v ON_ERROR_STOP=1 -f stub.sql -f supabase/migrations/001_base.sql \
     -f supabase/migrations/002_live_class.sql -f tests/sql/002_live_class_rls.sql   # RLS en Postgres 16 local
```

Para probar el camino LiveKit con el SDK real: `npm pack livekit-client@2.22.3`, descomprimir y
correr `LK_UMD=<ruta>/package/dist/livekit-client.umd.js node tests/e2e-live.cjs`.
