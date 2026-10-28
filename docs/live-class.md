# Aula en vivo (Live class)

**Estado: DEMO, con la grabación real ya programada y APAGADA.** Hoy el aula en vivo funciona completa en el navegador,
con participantes simulados y datos de ejemplo. No hay servidor de video, no se graba nada y no cuesta nada.
- Video real: alcanza con cargar 3 variables de LiveKit en Vercel (pasos 1 y 2).
- Grabación → transcripción → insights reales: el código está hecho (LiveKit Egress → Azure Blob → Azure Speech → Azure
  OpenAI) y queda **apagado** hasta que se cargan TODAS sus variables (paso 4). Mientras tanto la sala dice "Grabación lista
  para activarse — todavía no se graba nada".

## Qué hay en el código

| Archivo | Qué hace |
|---|---|
| `public/live-class.js` | Toda la pantalla: inicio (sesiones), sala de espera con cámara real y el consentimiento (una casilla, se pide una sola vez; "Justificá tu respuesta" si no acepta), sala con video, plan con temporizadores, chat, indicador de grabación automática con pausa del docente, procesamiento e insights; y en el menú del perfil "Grabación de mis clases". Textos en español en un bloque `Object.assign(I18N_ES, …)`. |
| `public/live-class.css` | Estilos (sin librerías). Funciona desde 768 px de ancho. |
| `api/_lib/class/config.js` | `GET` → `{configured: true/false}`. Nunca devuelve claves. |
| `api/_lib/class/token.js` | `POST` → token de LiveKit (JWT HS256 firmado con `node:crypto`). Verifica la sesión de Supabase. Lee el consentimiento de la base (`my_consent()` con la sesión del usuario; **nunca** lo que manda el navegador) y pone `recorded` / `consent` / `minor` / `guardian_consent` en la metadata. Devuelve **501** mientras falten las variables. |
| `api/_lib/notify/consent.js` | `POST` → avisa por email a los admins cuando alguien no acepta la grabación (solo con `RESEND_API_KEY` + `SUPABASE_SERVICE_ROLE_KEY`; si no, no hace nada). |
| `api/livekit/webhook.js` | Recibe los eventos de LiveKit y verifica la firma. Con la grabación configurada: `room_started`, `track_published` (micrófono → vuelve a mirar el consentimiento en la base → Track Egress a Azure Blob), `egress_ended`, `room_finished` (→ "procesando"). Sin configurar, solo registra. |
| `api/_lib/livekit.js` | Firma/verificación de JWT y consulta de usuario en Supabase (compartido). |
| `api/_lib/rec/` | El pipeline de grabación: `env.js` (variables; apagado por defecto), `livekit-api.js` (API de servidor de LiveKit: Egress y RoomService), `azure.js` (SAS de Blob, borrado, Speech batch), `analysis.js` (prompts, validación del JSON, números calculados con las marcas de tiempo), `pipeline.js` (todo el flujo, idempotente). |
| `api/_lib/class/rec.js` | `POST /api/class/rec` — el/la docente (o suplente) pausa, reanuda o termina la clase: el servidor detiene / vuelve a empezar las grabaciones y, al terminar, cierra la sala para todos. |
| `api/_lib/class/process.js` | `/api/class/process` — avanza el procesamiento (trabajos de Speech, transcripción, análisis) con un límite de tiempo por llamada. `GET` = tarea diaria de Vercel (con `CRON_SECRET`; también borra el audio vencido); `POST {session}` = la app, mientras alguien de esa clase tiene sus Insights abiertos en "Procesando…". |
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
4. En *Settings → Webhooks* agregar **`https://teroclass.com/api/livekit/webhook`**
   con esa misma API key.

### 2. Variables en Vercel

Vercel → Project → Settings → Environment Variables (Production), luego **Redeploy**:

| Variable | Ejemplo |
|---|---|
| `LIVEKIT_URL` | `wss://teroclass-prod-xxxx.livekit.cloud` |
| `LIVEKIT_API_KEY` | `APIxxxxxxxx` |
| `LIVEKIT_API_SECRET` | (secreto) |

Comprobar: `https://<tu-app>/api/class/config` debe responder `{"configured":true}`.
Desde ese momento las videollamadas son reales, todavía **sin grabar** (la sala dice "Grabación lista para activarse —
todavía no se graba nada") hasta completar el paso 4.

> Si el webhook responde "checksum does not match" en el primer deploy, agregar también
> `NODEJS_HELPERS=0` (hace que Vercel entregue el cuerpo crudo para verificar la firma).

### 3. Base de datos

Supabase → SQL Editor → pegar y ejecutar `supabase/migrations/002_live_class.sql`
(después del `001_base.sql` actual, que trae el consentimiento único; se puede volver a ejecutar sin riesgo).

### 4. Grabación real → transcripción → insights (apagada hasta cargar todo)

**Cómo funciona** (todo en el servidor; las claves nunca llegan al navegador):

1. **Grabar.** Cuando alguien publica su micrófono en una clase del calendario (sala `sess-<id de la clase>`), LiveKit avisa al
   webhook (`track_published`). El servidor **vuelve a mirar en la base** si esa persona es docente o estudiante de esa clase y si
   su consentimiento sigue vigente (nunca confía en la metadata ni en el navegador; la identidad de LiveKit es el id de usuario de
   Supabase). Si vale, le pide a LiveKit un **Track Egress solo de audio** de ese micrófono, que LiveKit escribe **directo en Azure
   Blob Storage** (Brazil South): un archivo `.ogg` por micrófono y por tramo. Nunca se graba video ni pantalla. Las salas rápidas
   (fuera del calendario) no se graban.
   - *Por qué Track Egress y no un grabador propio:* no hay que mantener otro servicio (Container Apps), escala solo y escribe
     directo en el Storage. Lo que se pierde: no recorta los silencios (cada archivo dura lo que la persona estuvo en la sala; ver
     costos) y la pausa corta el archivo (cada "Reanudar" empieza un tramo nuevo).
2. **"● Grabando".** Recién cuando el egress de alguien arrancó de verdad, el servidor marca `rec_active` en la metadata de esa
   persona: su insignia pasa a "Grabado/a" y el indicador de la sala a "● Grabando — solo quienes dieron su consentimiento".
   Antes (o con la grabación apagada) dice "Grabación lista para activarse — todavía no se graba nada".
3. **Pausa.** "Pausar grabación" del docente llama a `POST /api/class/rec` (solo docente / suplente de esa clase): el servidor
   detiene todos los egress y no empieza nuevos. "Reanudar" (o la reanudación automática a los 5 minutos, en el navegador del
   docente) vuelve a revisar el consentimiento de cada micrófono en la base y empieza tramos nuevos.
4. **Terminar.** "Terminar clase" del docente cierra la sala para todos (LiveKit `DeleteRoom`) y la llamada pasa a
   **"procesando"**. LiveKit avisa `egress_ended` por cada archivo: queda una fila en `recordings` con la ruta del archivo, la
   persona, la duración y `retention_until = ahora + 30 días`. Los reintentos de LiveKit no duplican nada.
5. **Transcribir.** Por cada archivo, el servidor arma un **link SAS de solo lectura que vence en 6 horas** y crea un trabajo de
   **Azure Speech batch** (REST `2024-11-15`, Brazil South) con marcas de tiempo por palabra. Idioma: el de la clase (el de la
   planificación adjunta: "Spanish" → `es-UY`, o `es-ES` con `RECORDING_SPANISH_LOCALE=es-ES`; si no, `en-US`, el de TEC).
   Al terminar, los segmentos quedan en `transcript_segments` con el tiempo desde el inicio de la llamada. Cada archivo es un
   solo micrófono: no hace falta separar voces ni huella de voz.
6. **Analizar.** Con todo transcripto, Azure OpenAI (el despliegue que elija el súper admin en *Plataforma → Modelo de IA →
   Insights de clase*; si no hay "mini", el de siempre) escribe:
   - el **informe del docente** (guía TEC: evidencia → impacto → próximo paso, las 13 áreas, con minutos, citas y cantidades;
     compara con la planificación adjunta o las notas del cuaderno de esa clase, si hay);
   - los **insights de cada estudiante que consintió** (de a 3 por llamada a la IA).
   El tiempo de habla, el % docente / estudiantes, las palabras por minuto, las preguntas (abiertas / cerradas), el tiempo de
   espera y la intervención más larga se **calculan en el código** con las marcas de tiempo. El JSON de la IA se **valida**
   (la forma exacta que muestra `public/insights-view.js`; si algo no cumple, no se guarda y se reintenta) y se guarda con
   `is_demo = false` (reemplaza los de demo de esa clase; la reflexión y los mensajes del docente quedan). Tope de tokens por
   clase (`INSIGHTS_SESSION_TOKEN_CAP`, 150.000 por defecto); el consumo se anota como tipo `insights` (Métricas y saldo del
   plan, a nombre del docente).
7. **Quién lo hace avanzar** (cada llamada trabaja menos de 50 s y deja todo listo para la siguiente):
   - el webhook al terminar la clase (primer intento: crea los trabajos de Speech);
   - la app: quien abre los Insights de esa clase (docente / suplente, admins o sus estudiantes) ve **"Procesando tu clase…
     (puede tardar unos minutos)"** y la página le pide al servidor que avance cada ~20 s hasta que aparecen los insights reales;
   - la tarea diaria de Vercel (`vercel.json → crons`, 07:17 UTC; en el plan Hobby solo puede correr una vez por día).
8. **Borrado.** La misma tarea diaria borra del Storage el audio con más de 30 días (`recordings_due_for_deletion()`) y lo marca
   borrado. Las transcripciones y los insights quedan. Además, la regla de ciclo de vida del Storage (abajo) lo borra igual si
   algo fallara.

**Pasos del dueño (una sola vez):**

*A. Almacenamiento (Azure Storage, Brazil South)*
1. Entrar a <https://portal.azure.com> → **Crear un recurso** → buscar **Cuenta de almacenamiento** (Storage account) → Crear.
2. Grupo de recursos: el de TeroClass. Nombre: por ejemplo `teroclassrec` (solo minúsculas y números). **Región: (South
   America) Brazil South.** Rendimiento: Estándar. Redundancia: LRS.
3. Pestaña **Avanzado**: "Permitir el acceso anónimo a blobs" **desactivado**; "Requerir transferencia segura" activado; TLS 1.2.
   Revisar y crear.
4. En el recurso: **Almacenamiento de datos → Contenedores → + Contenedor**. Nombre `recordings`, nivel de acceso **Privado (sin
   acceso anónimo)**.
5. **Administración de datos → Administración del ciclo de vida → Agregar una regla** (respaldo de los 30 días): nombre
   `borrar-30-dias`; "Limitar blobs con filtros"; tipo: blobs en bloques; filtro de prefijo `recordings/`; condición "Última
   modificación hace más de **30** días" → **Eliminar el blob**. Guardar.
6. **Seguridad y redes → Claves de acceso** → "Mostrar" en **key1** → copiar el **Nombre de la cuenta de almacenamiento** y la
   **Clave**.

*B. Transcripción (Azure AI Speech, Brazil South)*
1. **Crear un recurso** → buscar **Speech** (Servicios de Voz de Azure AI) → Crear.
2. Mismo grupo de recursos. **Región: Brazil South.** Nombre: por ejemplo `teroclass-speech`. Plan de tarifa: **Standard S0**
   (el gratuito no sirve para transcripción por lotes).
3. En el recurso: **Claves y punto de conexión** → copiar **CLAVE 1** y la **Ubicación/Región** (`brazilsouth`).

*C. LiveKit*
1. <https://cloud.livekit.io> → el proyecto → **Settings → Webhooks → Add**: URL **`https://teroclass.com/api/livekit/webhook`**,
   firmado con la misma API key que `LIVEKIT_API_KEY`.
2. Confirmar que el plan incluye minutos de **Egress** (Track Egress).

*D. Vercel → Project → Settings → Environment Variables (Production), luego Redeploy*

| Variable | Valor |
|---|---|
| `RECORDING_ENABLED` | `true` (para apagar todo: `false` y Redeploy) |
| `AZURE_STORAGE_ACCOUNT` | el nombre de la cuenta (A.6), ej. `teroclassrec` |
| `AZURE_STORAGE_KEY` | la clave **key1** (A.6) |
| `AZURE_STORAGE_CONTAINER` | `recordings` |
| `AZURE_SPEECH_KEY` | la **CLAVE 1** de Speech (B.3) |
| `AZURE_SPEECH_REGION` | `brazilsouth` |
| `CRON_SECRET` | 32 caracteres o más al azar (por ejemplo, lo que devuelve `openssl rand -hex 32`). Vercel lo manda solo en la tarea diaria. |
| ya existentes | `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_KEY` (y `AZURE_OPENAI_DEPLOYMENT_MINI` si se usa "mini") |
| opcionales | `INSIGHTS_SESSION_TOKEN_CAP` (tope de tokens de IA por clase, 150000), `RECORDING_SPANISH_LOCALE` (`es-UY` por defecto, o `es-ES`), `AZURE_SPEECH_API_VERSION` (`2024-11-15`) |

Sin **todas** las obligatorias (incluida `SUPABASE_SERVICE_ROLE_KEY`) la grabación sigue apagada. Sin las de Azure OpenAI se
graba y se transcribe, pero el análisis espera hasta que estén.

*E. Base de datos*: Supabase → SQL Editor → volver a ejecutar `supabase/migrations/001_base.sql` (crea las tablas de la llamada
si 002 todavía no corrió, y las funciones del pipeline). `002_live_class.sql` es opcional (agrega lecturas directas y la auditoría
`consents`); si se corre, va después.

*F. Comprobar*: `https://teroclass.com/api/health` → `"recording_configured": true`. En Vercel → Settings → **Cron Jobs** aparece
`/api/class/process` (diaria). Hacer una clase de prueba de 5 minutos con dos cuentas que aceptaron: al terminar, Insights muestra
"Procesando tu clase…" y a los pocos minutos el informe real (sin la etiqueta "Demo").

### 5. Qué queda en la base

`live_sessions` (una por clase del calendario; `status` live → processing → ready / ended, `rec_state` on / paused, tokens
usados), `session_participants` (quién estuvo y si se grabó), `recordings` (un tramo por egress: archivo, duración, Speech,
`retention_until`, `deleted_at`), `transcript_segments` (texto con tiempos) y los insights en `teacher_insights` /
`student_insights` (`is_demo = false`, `001_base.sql`). Escribe solo el servidor (`service_role`) con las funciones `rec_*`; la app
solo pregunta el estado (`rec_session_status`, `rec_processing_sessions`) con las mismas reglas que los insights.

## Costos (estimación por hora de clase — verificar precios vigentes)

Ejemplo: 1 hora de clase con **26 personas grabadas** (25 estudiantes + docente, todas aceptaron). N = personas grabadas.

| Pieza | Cómo se cobra | Por hora de clase |
|---|---|---|
| LiveKit Cloud (video) | minutos de conexión por participante (26 × 60 = 1.560 min) y ancho de banda | según plan (minutos incluidos) |
| LiveKit Track Egress | minutos de egress: N × 60 (26 × 60 = 1.560 min de audio) | según plan: revisar el precio de Egress |
| Azure Blob Storage | Ogg/Opus ≈ 10–15 MB por persona y hora → ≈ 0,3 GB, 30 días | < US$ 0,01 |
| Azure AI Speech (batch) | por hora de **audio**; cada micrófono es un archivo de toda la clase (sin recortar silencios) → N horas | ≈ US$ 0,18 × 26 ≈ **US$ 4,7** (con 10 grabados ≈ US$ 1,8) |
| Azure OpenAI (GPT-4o) | tokens: informe ≈ 15–20 mil + ≈ 8–10 mil cada 3 estudiantes → ≈ 90–110 mil (tope 150 mil) | ≈ US$ 0,3–0,6 (con "mini" ≈ US$ 0,05) |
| Vercel / Supabase | funciones y base, dentro del plan | US$ 0 |

**Total aproximado: US$ 2–6 por hora de clase, más los minutos de LiveKit**, según cuántas personas se graban. Lo que más pesa es
Speech (cobra también los silencios de cada micrófono): un grabador propio con detección de voz lo bajaría, a cambio de mantener
otro servicio.

Hoy, en modo Demo y con la grabación apagada: **US$ 0**.

## Privacidad — checklist antes de activar

- [ ] Texto de consentimiento revisado por un abogado (Uruguay: Ley 18.331; España: RGPD/LOPDGDD) y versión cargada en `CONSENT_VERSION` (`api/_lib/class/token.js`, `live-class.js`) y `tc_consent_version()` (`001_base.sql`).
- [ ] Decisión del producto (2026-10): **un solo consentimiento** (grabación + análisis con IA + almacenamiento), se pide una vez y un "sí" queda guardado; un "no" ofrece un comentario OPCIONAL ("¿Querés contarnos por qué? (opcional)"; solo si se escribe algo le llega a la institución, en gris neutro) y se vuelve a preguntar en la próxima clase. Sin consentimiento se participa igual, sin grabar. Confirmar con el abogado que agrupar los tres fines en una casilla es válido.
- [ ] Menores de 18: hoy el estudiante escribe nombre y email del tutor/a y **declara** que está de acuerdo (se muestra "declarado por el estudiante", no está verificado), o la institución enciende "Nuestra institución junta el consentimiento de las familias" (`consent_managed_by_institution`) y entonces no se piden datos del tutor/a.
- [ ] **PENDIENTE (TODO): verificación real del tutor/a por email** (link firmado al email del tutor/a; el "sí" del menor cuenta recién cuando confirma). Decidirlo con el abogado antes de grabar a menores.
- [ ] Indicador siempre visible para todos; dice "● Grabando — solo quienes dieron su consentimiento" **solo** con la grabación configurada (todas las variables del paso 4) y cuando el servidor ya empezó a grabar a alguien; si no, dice "Grabación lista para activarse — todavía no se graba nada". El docente puede pausar (el servidor detiene la grabación; se reanuda sola a los 5 min).
- [ ] Salas rápidas (fuera del calendario): los estudiantes entran solo con el link de invitación de quien creó la sala (`api/class/ticket`, vence a las 6 h; firma derivada de `LIVEKIT_API_SECRET` o `ROOM_TICKET_SECRET`). El rol (docente / estudiante) lo decide el servidor.
- [ ] Se identifica a cada persona por su micrófono, nunca por huella de voz. Sin detección de emociones.
- [ ] Solo se graba audio con voz de quienes consintieron; nunca video.
- [ ] Audio original borrado a los 30 días (tarea diaria de Vercel `/api/class/process` + regla de ciclo de vida del Storage; probarlo una vez).
- [ ] Datos en la región (LiveKit con región fijada si el plan lo permite; Azure en Brazil South).
- [ ] Revocar desde el perfil (`revoke_recording_consent`, o `revoke_consent` en 002) detiene la grabación de esa persona: el servidor revisa el consentimiento en cada micrófono publicado y en cada "Reanudar". PENDIENTE: dentro de una clase ya empezada, la grabación en curso sigue hasta la próxima pausa o reconexión (falta cortarla al instante).
- [ ] Insights del docente privados (solo docente y admins de su institución); cada estudiante ve solo los suyos y el mensaje del docente cuando lo publica (ya aplicado en 001_base.sql).
- [ ] Acceso del tutor/a a los insights publicados del menor (hoy no existe: definirlo antes de grabar).
- [ ] Contrato de encargado de tratamiento con LiveKit y Microsoft.

## Pruebas

```bash
NODE_PATH=/opt/npm-tools/node_modules node tests/e2e-live.cjs        # navegador, modo demo (+ camino LiveKit)
NODE_PATH=/opt/npm-tools/node_modules node tests/e2e-recording.cjs   # "Procesando tu clase…" y después los insights reales
node --no-warnings --test tests/api-recording.test.mjs               # webhook → egress (consentimiento en la base), pausa, SAS, Speech, análisis, borrado, cron
PGHOST=… PGPORT=… PGUSER=postgres bash tests/sql/run.sh               # incluye tests/sql/recording.sql
NODE_PATH=/opt/npm-tools/node_modules node tests/e2e-consent.cjs     # consentimiento, justificación, perfil, admin
node --no-warnings --test tests/api-live.test.mjs tests/api-consent.test.mjs   # token (consentimiento desde la base) / config / webhook / aviso
psql -v ON_ERROR_STOP=1 -f stub.sql -f supabase/migrations/001_base.sql \
     -f supabase/migrations/002_live_class.sql -f tests/sql/002_live_class_rls.sql   # RLS en Postgres 16 local
```

Para probar el camino LiveKit con el SDK real: `npm pack livekit-client@2.22.3`, descomprimir y
correr `LK_UMD=<ruta>/package/dist/livekit-client.umd.js node tests/e2e-live.cjs`.
