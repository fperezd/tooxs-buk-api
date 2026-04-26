# Agente BUK para Tooxs

Este proyecto crea un agente de linea de comandos para "hablar" con BUK usando instrucciones en espanol.
Primero se conecta al BUK Starter de Tooxs y, si no esta configurado, puede operar en modo directo a BUK.

## Que hace

- Recibe comandos tipo chat en consola.
- Traduce comandos a llamadas HTTP (GET/POST) contra la API de BUK.
- Incluye comandos rapidos para busqueda de empleados.

## Requisitos

- Node.js 18.17 o superior.
- Credenciales de API de BUK de Tooxs.

## Configuracion

1. Copia `.env.example` a `.env`.
2. Completa tus credenciales del BUK Starter de Tooxs:

```env
BUK_STARTER_BASE_URL=https://buk-starter.tooxs.cl
BUK_STARTER_API_TOKEN=tu_token_starter
BUK_STARTER_AUTH_HEADER=Authorization
BUK_STARTER_AUTH_SCHEME=Bearer
BUK_STARTER_LEGACY_AUTH_HEADER=auth_token
BUK_STARTER_SEND_LEGACY_AUTH_HEADER=true
BUK_STARTER_ROUTE_PREFIX=/api/buk
BUK_STARTER_HEALTH_PATH=/health
BUK_TIMEOUT_MS=15000
```

Si no usas Starter, puedes configurar `BUK_BASE_URL` y `BUK_API_TOKEN` para modo directo.

## Ejecutar

```bash
npm install
npm start
```

## Comandos del agente

- `ayuda`
- `salir`
- `ping`
- `ping starter`
- `empleados`
- `buscar empleado <texto>`
- `empleado <id>`
- `get <ruta>[?query]`
- `post <ruta> <json>`

Ejemplos:

```text
buscar empleado maria
empleado 12345
ping starter
empleados
get /api/v1/employees?search=martin
post /employees {"name":"Ana","last_name":"Perez"}
```

## Nota importante sobre endpoints

Los endpoints exactos pueden variar segun tu version/tenant de BUK. Si tu API usa otras rutas, puedes usar el comando `get` y `post` para operar cualquier endpoint, por ejemplo:

```text
get /v1/people
post /v1/requests {"type":"vacation","employee_id":"123"}
```

Si quieres, en el siguiente paso te lo personalizo con los endpoints reales de Tooxs (vacaciones, ausencias, contratos, liquidaciones, etc.) para que quede totalmente en lenguaje natural.
